import Foundation
import Testing
@testable import SignalboxKit

@Suite("CLI transport against a fake CLI", .serialized)
struct TransportTests {
    func launch() -> CLILaunch {
        CLILaunch(executable: URL(fileURLWithPath: "/bin/sh"), leadingArguments: [TestPaths.fakeCLI.path])
    }

    func config(env: [String: String] = [:], initial: Duration = .milliseconds(50), max: Duration = .milliseconds(200)) -> CLIProcess.Configuration {
        var environment = ProcessInfo.processInfo.environment
        environment.merge(env) { _, new in new }
        return CLIProcess.Configuration(
            launch: launch(),
            environment: environment,
            initialBackoff: initial,
            maxBackoff: max,
            stableAfter: .seconds(60),
            terminateGrace: .milliseconds(500)
        )
    }

    @Test func streamsLinesAndAnswersCommands() async throws {
        let cli = CLIProcess(configuration: config())
        let rec = EventRecorder()
        await rec.start(cli.events)
        await cli.start(days: 30)

        let gotInitial = await rec.waitUntil { events in
            events.messages.contains { if case .hello = $0 { true } else { false } }
                && events.fleetCount == 1
                && events.reportDays == [30]
                && events.messages.contains(.unknown(type: "from-the-future"))
                && events.contains { if case .protocolError = $0 { true } else { false } }
        }
        #expect(gotInitial)

        // Lenient decoding made it through the transport: unknown status and extra fields.
        let fleet = await rec.events.messages.compactMap { if case let .fleet(_, f) = $0 { f } else { nil } }.first
        #expect(fleet?.sessions.map(\.status) == [.waiting, .unknown])

        await cli.send(.report(days: 1))
        #expect(await rec.waitUntil { $0.reportDays == [30, 1] })
        await cli.send(.refresh)
        #expect(await rec.waitUntil { $0.fleetCount == 2 && $0.reportDays == [30, 1, 1] })
        // The fake echoes each command to stderr.
        let stderr = await rec.events.stderrLines
        #expect(stderr.contains("fake-cli: got {\"cmd\":\"report\",\"days\":1}"))
        #expect(stderr.contains("fake-cli: got {\"cmd\":\"refresh\"}"))
        #expect(stderr.first == "fake-cli: starting (days=30)")

        await cli.stop()
        // Closing stdin made the fake exit on its own (no SIGTERM needed): it said goodbye on stderr.
        #expect(await rec.waitUntil(timeout: .seconds(2)) { $0.stderrLines.contains("fake-cli: stdin closed, exiting") })
        await rec.stop()
    }

    @Test func restartsWithBackoffWhenTheCLIExits() async throws {
        let state = FileManager.default.temporaryDirectory.appendingPathComponent("signalbox-fake-\(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: state) }
        let cli = CLIProcess(configuration: config(env: ["FAKE_CLI_MODE": "exit-after-hello", "FAKE_CLI_STATE": state.path]))
        let rec = EventRecorder()
        await rec.start(cli.events)
        await cli.start(days: 7)

        let restarted = await rec.waitUntil { $0.starts >= 3 }
        #expect(restarted)
        await cli.stop()

        let events = await rec.events
        let exits = events.compactMap { if case let .exited(status, signaled) = $0 { (status, signaled) } else { nil } }
        #expect(exits.first.map { $0.0 == 3 && !$0.1 } == true)
        let delays = events.compactMap { if case let .restarting(attempt, delay) = $0 { (attempt, delay) } else { nil } }
        #expect(delays.count >= 2)
        #expect(delays[0].0 == 1 && delays[0].1 == .milliseconds(50))
        #expect(delays[1].0 == 2 && delays[1].1 == .milliseconds(100))
        let log = try String(contentsOf: state, encoding: .utf8)
        #expect(log.components(separatedBy: "\n").filter { $0 == "start days=7" }.count >= 3)
        await rec.stop()
    }

    @Test func restartUsesTheLatestReportWindow() async throws {
        let state = FileManager.default.temporaryDirectory.appendingPathComponent("signalbox-fake-\(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: state) }
        let cli = CLIProcess(configuration: config(env: ["FAKE_CLI_MODE": "exit-after-hello", "FAKE_CLI_STATE": state.path], initial: .milliseconds(300), max: .milliseconds(300)))
        let rec = EventRecorder()
        await rec.start(cli.events)
        await cli.start(days: 7)
        #expect(await rec.waitUntil { $0.contains { if case .restarting = $0 { true } else { false } } })
        // The user switched to "Today" while the CLI was down; the next start must use it.
        await cli.send(.report(days: 1))
        #expect(await rec.waitUntil { $0.starts >= 2 })
        await cli.stop()
        let log = try String(contentsOf: state, encoding: .utf8)
        #expect(log.contains("start days=1"))
        await rec.stop()
    }

    @Test func reportsALaunchFailureAndKeepsTrying() async {
        let bad = CLIProcess.Configuration(
            launch: CLILaunch(executable: URL(fileURLWithPath: "/nonexistent/signalbox")),
            initialBackoff: .milliseconds(20),
            maxBackoff: .milliseconds(40)
        )
        let cli = CLIProcess(configuration: bad)
        let rec = EventRecorder()
        await rec.start(cli.events)
        await cli.start(days: 7)
        let failedTwice = await rec.waitUntil { events in
            events.filter { if case .launchFailed = $0 { true } else { false } }.count >= 2
        }
        #expect(failedTwice)
        await cli.stop()
        // Each launch failure is followed by a restart: the store must keep the failure visible across it.
        let events = await rec.events
        for (i, e) in events.enumerated() {
            if case .launchFailed = e, i + 1 < events.count {
                #expect({ if case .restarting = events[i + 1] { true } else { false } }())
            }
        }
        await rec.stop()
    }

    @MainActor
    @Test func aCLIThatKeepsFailingShowsWhyInTheStore() async {
        let cli = CLIProcess(configuration: config(env: ["FAKE_CLI_MODE": "fail-before-hello"], initial: .milliseconds(20), max: .milliseconds(40)))
        let store = SignalboxStore()
        store.connect(cli)
        let failed = await eventually(timeout: .seconds(10)) {
            if case let .failed(reason, _, _) = store.connection {
                return reason == "exited with status 1: fake-cli: cannot read the price tables"
            }
            return false
        }
        #expect(failed, "connection: \(store.connection)")
        #expect(store.failedStarts >= SignalboxStore.failedStartThreshold)
        await store.disconnect()
    }

    @Test func stopTerminatesAChildThatIgnoresStdin() async throws {
        // `sleep` never reads stdin, so closing it does nothing: stop() must escalate to SIGTERM.
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("signalbox-sleeper-\(UUID().uuidString).sh")
        try "echo '{\"type\":\"hello\",\"v\":1,\"version\":\"x\"}'\nexec sleep 30\n".write(to: script, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: script) }
        let cfg = CLIProcess.Configuration(
            launch: CLILaunch(executable: URL(fileURLWithPath: "/bin/sh"), leadingArguments: [script.path]),
            terminateGrace: .milliseconds(200)
        )
        let cli = CLIProcess(configuration: cfg)
        let rec = EventRecorder()
        await rec.start(cli.events)
        await cli.start(days: 7)
        #expect(await rec.waitUntil { $0.messages.contains { if case .hello = $0 { true } else { false } } })
        let pid = await rec.events.compactMap { if case let .started(pid, _) = $0 { pid } else { nil } }.first
        let began = ContinuousClock.now
        await cli.stop()
        #expect(ContinuousClock.now - began < .seconds(3))
        if let pid {
            try? await Task.sleep(for: .milliseconds(100))
            #expect(kill(pid, 0) != 0, "child should be gone after stop()")
        }
        await rec.stop()
    }

    @Test func backoffDoublesUpToTheCap() {
        let d = (1...7).map { CLIProcess.backoff(attempt: $0, initial: .seconds(1), max: .seconds(30)) }
        #expect(d == [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(16), .seconds(30), .seconds(30)])
        #expect(CLIProcess.backoff(attempt: 500, initial: .seconds(1), max: .seconds(30)) == .seconds(30))
    }
}

@Suite("Environment and CLI location")
struct EnvironmentTests {
    @Test func mergesPATHWithoutDuplicates() {
        let p = ShellEnvironment.mergedPATH(login: "/opt/homebrew/bin:/usr/bin:/bin", inherited: "/usr/bin:/bin:/usr/sbin", home: "/Users/you")
        let parts = p.split(separator: ":").map(String.init)
        #expect(parts.first == "/opt/homebrew/bin")
        #expect(parts == Array(NSOrderedSet(array: parts)) as? [String])
        #expect(parts.contains("/Users/you/.local/bin"))
        #expect(parts.contains("/usr/local/bin"))
        #expect(parts.contains("/usr/sbin"))
    }

    @Test func fallsBackWhenTheLoginShellFails() {
        let p = ShellEnvironment.mergedPATH(login: nil, inherited: nil, home: "/h")
        #expect(p.hasPrefix("/h/.local/bin:/opt/homebrew/bin:/usr/local/bin"))
    }

    @Test func extractsTheMarkedPATH() {
        let m = "__M__"
        let noisy = Data("Last login: …\nwelcome!\n\(m)/a/bin:/b/bin\(m)zsh: exit\n".utf8)
        #expect(ShellEnvironment.extract(from: noisy, marker: m) == "/a/bin:/b/bin")
        #expect(ShellEnvironment.extract(from: Data("no markers".utf8), marker: m) == nil)
        #expect(ShellEnvironment.extract(from: Data("\(m)\(m)".utf8), marker: m) == nil)
    }

    @Test func resolvesTheLoginShellPATH() async {
        // Real zsh, real dotfiles: just check the plumbing returns something PATH-shaped in time.
        let began = ContinuousClock.now
        let path = await ShellEnvironment.loginShellPATH(timeout: .seconds(6))
        #expect(ContinuousClock.now - began < .seconds(7))
        if let path { #expect(path.contains("/usr/bin")) }
    }

    @Test func asksTheUsersOwnShell() {
        let shell = ShellEnvironment.userShell()
        #expect(FileManager.default.isExecutableFile(atPath: shell))
        let m = "__M__"
        let zsh = ShellEnvironment.loginInvocation(shell: "/bin/zsh", marker: m)
        #expect(zsh.executable == "/bin/zsh")
        #expect(zsh.arguments.prefix(3) == ["-l", "-i", "-c"])
        #expect(zsh.arguments.last?.contains("\"$PATH\"") == true)
        #expect(ShellEnvironment.loginInvocation(shell: "/opt/homebrew/bin/bash", marker: m).executable == "/opt/homebrew/bin/bash")
        // fish keeps PATH as a list, so it's joined explicitly.
        let fish = ShellEnvironment.loginInvocation(shell: "/opt/homebrew/bin/fish", marker: m)
        #expect(fish.executable == "/opt/homebrew/bin/fish")
        #expect(fish.arguments.last?.contains("string join : $PATH") == true)
        // csh-style syntax isn't spoken: zsh is asked instead.
        #expect(ShellEnvironment.loginInvocation(shell: "/bin/tcsh", marker: m).executable == "/bin/zsh")
    }

    @Test func resolvesAPATHFromBash() async {
        // bash reads different startup files than zsh; the plumbing must work for it too.
        let path = await ShellEnvironment.loginShellPATH(shell: "/bin/bash", timeout: .seconds(6))
        if let path { #expect(path.contains("/usr/bin")) }
    }

    @Test func childEnvironmentKeepsHomeAndReplacesPATH() {
        let env = ShellEnvironment.childEnvironment(base: ["HOME": "/Users/you", "PATH": "/usr/bin", "LANG": "en_US.UTF-8"], path: "/x:/y")
        #expect(env["HOME"] == "/Users/you")
        #expect(env["PATH"] == "/x:/y")
        #expect(env["LANG"] == "en_US.UTF-8")
    }

    @Test func locatesTheCLIInOrder() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("signalbox-locate-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let resources = dir.appendingPathComponent("Resources")
        try fm.createDirectory(at: resources, withIntermediateDirectories: true)
        let bundled = resources.appendingPathComponent("signalbox")
        try "#!/bin/sh\n".write(to: bundled, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundled.path)
        let binDir = dir.appendingPathComponent("bin")
        try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        let bun = binDir.appendingPathComponent("bun")
        try "#!/bin/sh\n".write(to: bun, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bun.path)
        let mainTS = dir.appendingPathComponent("main.ts")
        try "".write(to: mainTS, atomically: true, encoding: .utf8)

        // 1. Bundled when nothing is set.
        #expect(CLILocator.locate(environment: [:], bundleResources: resources, searchPATH: "") == .found(CLILaunch(executable: bundled, origin: .bundled)))
        // 2. An explicit binary wins.
        #expect(CLILocator.locate(environment: ["SIGNALBOX_CLI": bun.path], bundleResources: resources, searchPATH: "")
            == .found(CLILaunch(executable: bun, origin: .environmentBinary)))
        // 3. bun:/path/main.ts runs `bun main.ts`.
        let dev = CLILocator.locate(environment: ["SIGNALBOX_CLI": "bun:\(mainTS.path)"], bundleResources: resources, searchPATH: binDir.path)
        #expect(dev == .found(CLILaunch(executable: bun, leadingArguments: [mainTS.path], origin: .environmentBun(script: mainTS.path))))
        if case let .found(l) = dev {
            #expect(l.watchArguments(days: 30) == [mainTS.path, "watch", "--ndjson", "--days", "30"])
        }
        // 4. A broken explicit setting is reported, not silently skipped.
        guard case .missing = CLILocator.locate(environment: ["SIGNALBOX_CLI": "/nope"], bundleResources: resources, searchPATH: "") else {
            Issue.record("expected missing")
            return
        }
        guard case .missing = CLILocator.locate(environment: ["SIGNALBOX_CLI": "bun:\(mainTS.path)"], bundleResources: nil, searchPATH: "/empty") else {
            Issue.record("expected missing bun")
            return
        }
        // 5. Nothing anywhere.
        guard case let .missing(reason) = CLILocator.locate(environment: [:], bundleResources: dir, searchPATH: "") else {
            Issue.record("expected missing")
            return
        }
        #expect(reason.contains("SIGNALBOX_CLI"))

        // 6. The Settings override sits between SIGNALBOX_CLI and the bundled CLI.
        #expect(CLILocator.locate(environment: [:], override: bun.path, bundleResources: resources, searchPATH: "")
            == .found(CLILaunch(executable: bun, origin: .settingsOverride)))
        #expect(CLILocator.locate(environment: ["SIGNALBOX_CLI": bundled.path], override: bun.path, bundleResources: resources, searchPATH: "")
            == .found(CLILaunch(executable: bundled, origin: .environmentBinary)))
        #expect(CLILocator.locate(environment: [:], override: "  ", bundleResources: resources, searchPATH: "")
            == .found(CLILaunch(executable: bundled, origin: .bundled)))
        // A bun script from Settings says it came from Settings, not from SIGNALBOX_CLI.
        let settingsBun = CLILocator.locate(environment: [:], override: "bun:\(mainTS.path)", bundleResources: resources, searchPATH: binDir.path)
        #expect(settingsBun == .found(CLILaunch(executable: bun, leadingArguments: [mainTS.path], origin: .settingsBun(script: mainTS.path))))
        if case let .found(l) = settingsBun {
            #expect(l.originDescription == "bun script from Settings")
        }
        if case let .found(l) = dev {
            #expect(l.originDescription == "SIGNALBOX_CLI bun script")
        }
        guard case let .missing(overrideReason) = CLILocator.locate(environment: [:], override: "/nope", bundleResources: resources, searchPATH: "") else {
            Issue.record("a broken override must be reported, not skipped")
            return
        }
        #expect(overrideReason.contains("Settings"))
    }
}
