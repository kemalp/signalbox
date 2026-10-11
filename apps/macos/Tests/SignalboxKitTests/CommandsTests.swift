import Foundation
import Testing
@testable import SignalboxKit

@Suite("Command guide: decoding")
struct CommandDecodingTests {
    @Test func decodesTheFixture() throws {
        let c = try TestPaths.loadCommands()
        #expect(c.v == 1)
        #expect(c.generatedAt == date("2026-10-09T14:30:00.000Z"))
        #expect(c.catalogs.map(\.agent) == [.claudeCode, .codex, .geminiCLI])
        #expect(c.installedVersion(.claudeCode) == "2.1.293")
        #expect(c.installedVersion(.geminiCLI) == nil)
        #expect(c.agents == [.claudeCode, .codex, .geminiCLI])

        let claude = try #require(c.catalog(for: .claudeCode))
        #expect(claude.verifiedVersion == "2.1.293")
        #expect(claude.commands.count > 100)
        #expect(!claude.cliCommands.isEmpty)
        let compact = try #require(claude.command(["/compact"]))
        #expect(compact.category == .context)
        #expect(compact.signalbox.status == .planned)
        #expect(compact.surfaces.terminal == .yes)
        #expect(compact.sideEffects != nil)
        let agents = try #require(claude.cliCommands.first { $0.name == "claude agents --json" })
        #expect(agents.signalbox.status == .view)
        #expect(SidebarSection(catalogView: agents.signalbox.view) == .sessions)

        // Every entry the catalogs carry decoded (nothing dropped as malformed).
        let raw = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: TestPaths.commandsFixture)) as? [String: Any])
        let rawCatalogs = try #require(raw["catalogs"] as? [[String: Any]])
        for (decoded, r) in zip(c.catalogs, rawCatalogs) {
            #expect(decoded.commands.count == (r["commands"] as? [Any])?.count)
            #expect(decoded.cliCommands.count == (r["cliCommands"] as? [Any])?.count)
        }
        #expect(c.custom.count == 8)
        #expect(c.custom.contains { $0.scope == .project && $0.project == "/Users/you/code/storefront" })
    }

    /// The fixture uses only values this app knows by name, so a new value the CLI starts sending (which
    /// apps/cli/test/commands-fixture.test.ts makes the fixture carry) fails here until the app handles it.
    @Test func theFixtureUsesOnlyValuesTheAppKnows() throws {
        let c = try TestPaths.loadCommands()
        let commands = c.catalogs.flatMap { $0.commands + $0.cliCommands }
        let knownStatuses: Set<CommandRunStatus> = [.view, .planned, .no, .never]
        let knownMethods: Set<String> = ["binary", "help", "docs", "observed"]
        for command in commands {
            #expect(CommandCategory.known.contains(command.category), "\(command.name): category \(command.category.rawValue)")
            #expect(knownStatuses.contains(command.signalbox.status), "\(command.name): status \(command.signalbox.status.rawValue)")
            if let view = command.signalbox.view {
                #expect(SidebarSection(catalogView: view) != nil, "\(command.name): view \(view)")
            }
            #expect(Set(command.surfaces.values.keys).isSubset(of: CommandSurfaces.knownKeys), "\(command.name): surfaces \(command.surfaces.values.keys.sorted())")
            if let method = command.verified?.method {
                #expect(knownMethods.contains(method), "\(command.name): verified.method \(method)")
            }
        }
        let knownKinds: Set<CustomCommandKind> = [.command, .skill, .prompt, .pluginCommand, .pluginSkill]
        let knownScopes: Set<CustomCommandScope> = [.user, .project, .plugin]
        for custom in c.custom {
            #expect(knownKinds.contains(custom.kind), "\(custom.name): kind \(custom.kind.rawValue)")
            #expect(knownScopes.contains(custom.scope), "\(custom.name): scope \(custom.scope.rawValue)")
        }
    }

    @Test func codexPromptsAreMarkedLegacy() throws {
        let c = try TestPaths.loadCommands()
        let prompt = try #require(c.custom.first { $0.kind == .prompt })
        #expect(prompt.agent == .codex)
        #expect(prompt.isLegacyPrompt)
        #expect(prompt.kindTitle == "Legacy prompt")
        let skill = try #require(c.custom.first { $0.kind == .skill })
        #expect(!skill.isLegacyPrompt)
        #expect(skill.kindTitle == "Skill")
        #expect(!CustomCommand(agent: .claudeCode, name: "/x", kind: .prompt).isLegacyPrompt)
    }

    @Test func toleratesUnknownValuesAndDropsMalformedRows() throws {
        let json = """
        {"type":"commands","at":"2026-10-10T10:00:00Z","later":true,"data":{"v":1,"generatedAt":"2026-10-10T10:00:00Z",
         "installed":{"claude-code":"2.1.300","codex":42,"gemini-cli":null},
         "catalogs":[{"agent":"claude-code","verifiedVersion":"2.1.293","shiny":1,"commands":[
            {"name":"/warp","summary":"Bend time.","category":"timetravel","surfaces":{"terminal":true,"desktop":"beta","holo":"partial"},
             "signalbox":{"status":"someday","view":"cockpit"},"verified":{"method":"dream"},"extra":[1]},
            {"summary":"no name"},
            {"name":"","summary":"empty name"},
            {"name":"/bare"}
         ]},{"agent":"cursor-agent","commands":"not an array"},{"nope":true}],
         "custom":[{"agent":"codex","name":"$x","kind":"macro","scope":"team","description":"line one\\nline two"},{"agent":"codex"}]}}
        """
        guard case let .commands(at, data) = try StreamMessage.parse(json) else {
            Issue.record("not a commands line")
            return
        }
        #expect(at == date("2026-10-10T10:00:00Z"))
        #expect(data.installed == ["claude-code": "2.1.300"])
        #expect(data.catalogs.map(\.agent) == [.claudeCode, AgentID(rawValue: "cursor-agent")])
        let cmds = data.catalogs[0].commands
        #expect(cmds.map(\.name) == ["/warp", "/bare"])
        let warp = cmds[0]
        #expect(warp.category.rawValue == "timetravel")
        #expect(warp.category.title == "Timetravel")
        #expect(warp.surfaces.terminal == .yes)
        #expect(warp.surfaces.desktop == .unknown)
        #expect(warp.surfaces["holo"] == .partial)
        #expect(warp.surfaces.headless == .unknown)
        #expect(warp.surfaces.orderedKeys == ["terminal", "desktop", "headless", "remoteControl", "holo"])
        #expect(warp.signalbox.status.rawValue == "someday")
        #expect(SidebarSection(catalogView: warp.signalbox.view) == nil)
        #expect(warp.verified?.methodLabel == "dream")
        // Defaults for a minimal row: no summary, category other, unknown status and surfaces.
        let bare = cmds[1]
        #expect(bare.summary.isEmpty)
        #expect(bare.category == .other)
        #expect(bare.signalbox.status.rawValue == "unknown")
        #expect(data.catalogs[1].commands.isEmpty)
        // Custom: unknown kind and scope kept; a row without a name dropped; descriptions on one line.
        #expect(data.custom.count == 1)
        #expect(data.custom[0].kind.title == "Macro")
        #expect(data.custom[0].scope.title == "Team")
        #expect(data.custom[0].shortDescription == "line one line two")
    }

    @Test func anOlderAppIgnoresTheLineAndThisOneParsesIt() throws {
        // The line type is new; a line this app doesn't know stays `.unknown` (never fatal).
        #expect(try StreamMessage.parse(#"{"type":"commands-v2","data":{}}"#) == .unknown(type: "commands-v2"))
        guard case let .commands(_, data) = try StreamMessage.parse(#"{"type":"commands","data":{}}"#) else {
            Issue.record("an empty commands line should still parse")
            return
        }
        #expect(data.catalogs.isEmpty)
        #expect(data.installed.isEmpty)
    }

    @Test func surfaceValuesRoundTrip() throws {
        let s = CommandSurfaces(terminal: .yes, desktop: .partial, headless: .no, remoteControl: .unknown)
        let back = try SignalboxJSON.decoder().decode(CommandSurfaces.self, from: SignalboxJSON.encoder().encode(s))
        #expect(back == s)
        let json = String(decoding: try SignalboxJSON.encoder().encode(s), as: UTF8.self)
        #expect(json.contains(#""terminal":true"#))
        #expect(json.contains(#""headless":false"#))
        #expect(json.contains(#""desktop":"partial""#))
    }

    @Test func longCustomDescriptionsAreCut() {
        let c = CustomCommand(agent: .claudeCode, name: "/x", description: String(repeating: "a", count: 500))
        #expect(c.shortDescription?.count == CustomCommand.maxDescription)
        #expect(c.shortDescription?.hasSuffix("…") == true)
        #expect(CustomCommand(agent: .claudeCode, name: "/x", description: "  \n ").shortDescription == nil)
    }

    @Test func snapshotsMayCarryAGuide() throws {
        var s = try TestPaths.loadSnapshot()
        #expect(s.commands == nil)
        s.commands = CommandsData(installed: ["codex": "1.0"])
        let back = try Snapshot.decode(SignalboxJSON.encoder().encode(s))
        #expect(back.commands?.installed == ["codex": "1.0"])
    }
}

@MainActor
@Suite("Command guide: store")
struct CommandStoreTests {
    let t0 = date("2026-10-09T14:30:00Z")

    @Test func theLineFillsTheGuide() throws {
        let store = SignalboxStore(clock: { [t0] in t0 })
        #expect(store.commandGuideState(now: t0) == .loading)
        store.handle(.started(pid: 1, command: "x"))
        store.handle(.message(.hello(version: "0.4.0", protocolVersion: 1, pid: 1)))
        #expect(store.connectedAt == t0)
        #expect(store.commandGuideState(now: t0.addingTimeInterval(5)) == .loading)
        let data = try TestPaths.loadCommands()
        store.handle(.message(.commands(at: t0, data)))
        #expect(store.commands == data)
        #expect(store.commandsUpdatedAt == t0)
        #expect(store.commandGuideState(now: t0.addingTimeInterval(500)) == .ready)
    }

    @Test func aCLIThatNeverSendsItIsTooOld() {
        let store = SignalboxStore(clock: { [t0] in t0 })
        store.handle(.started(pid: 1, command: "x"))
        store.handle(.message(.hello(version: "0.1.0", protocolVersion: 1, pid: 1)))
        #expect(store.commandGuideState(now: t0.addingTimeInterval(SignalboxStore.commandGuideGrace - 1)) == .loading)
        #expect(store.commandGuideState(now: t0.addingTimeInterval(SignalboxStore.commandGuideGrace)) == .cliTooOld)
        // The CLI stops: the usual no-CLI states take over.
        store.handle(.exited(status: 1, signaled: false))
        store.handle(.restarting(attempt: 1, delay: .seconds(1)))
        #expect(store.commandGuideState(now: t0.addingTimeInterval(60)) == .unavailable)
    }

    @Test func fixturesWithAndWithoutAGuide() throws {
        let store = SignalboxStore(clock: { [t0] in t0 })
        store.load(snapshot: try TestPaths.loadSnapshot(), name: "snapshot.json")
        #expect(store.commandGuideState(now: t0) == .notInSnapshot)
        store.load(commands: try TestPaths.loadCommands())
        #expect(store.commandGuideState(now: t0) == .ready)
        #expect(store.commandsUpdatedAt == date("2026-10-09T14:30:00.000Z"))
    }

    @Test func aFailedGuideIsReportedUntilTheNextOne() throws {
        let store = SignalboxStore(clock: { [t0] in t0 })
        let line = try StreamMessage.parse(#"{"type":"error","at":"2026-10-09T14:30:00Z","scope":"commands","message":"catalog unreadable"}"#)
        guard case let .error(e) = line else {
            Issue.record("not an error line")
            return
        }
        #expect(e.scope == .commands)
        store.handle(.message(line))
        #expect(store.streamErrors[.commands]?.message == "catalog unreadable")
        store.handle(.message(.commands(at: t0, try TestPaths.loadCommands())))
        #expect(store.streamErrors[.commands] == nil)
    }

    @Test func theDebugLogCountsWithoutNames() throws {
        let line = DebugLog.describe(.commands(at: nil, try TestPaths.loadCommands()))
        #expect(line.hasPrefix("commands catalogs=[claude-code="))
        #expect(line.contains("custom=8"))
        #expect(!line.contains("release-notes"))
    }
}

@Suite("Command guide: filters, search and copy")
struct CommandGuideTests {
    let data: CommandsData

    init() throws {
        data = try TestPaths.loadCommands()
    }

    private func names(_ sections: [CommandGuideSection]) -> [String] {
        sections.flatMap { $0.custom.map(\.name) + $0.commands.map(\.command.name) }
    }

    @Test func sectionsComeInAFixedOrder() {
        let sections = CommandGuide.sections(data, filter: CommandFilter())
        #expect(sections.first?.kind == .custom)
        #expect(sections.last?.kind == .shell)
        let cats = sections.compactMap { if case let .category(c) = $0.kind { c } else { nil } }
        #expect(cats == cats.sorted())
        #expect(cats.first == .session)
        // Every built-in command lands in exactly one section.
        let total = data.catalogs.reduce(0) { $0 + $1.commands.count + $1.cliCommands.count }
        #expect(sections.reduce(0) { $0 + $1.commands.count } == total)
        #expect(sections.first?.count == data.custom.count)
    }

    @Test func unknownCategoriesSortAfterKnownOnes() {
        #expect(CommandCategory.other < CommandCategory(rawValue: "alchemy"))
        #expect(CommandCategory(rawValue: "alchemy") < CommandCategory(rawValue: "zoology"))
        #expect(CommandCategory.session < .context)
    }

    @Test func theSameCommandOfEachAgentSitsTogether() throws {
        let session = try #require(CommandGuide.sections(data, filter: CommandFilter()).first { $0.kind == .category(.session) })
        let clears = session.commands.enumerated().filter { $0.element.command.name == "/clear" }
        #expect(clears.map(\.element.agent) == [.claudeCode, .codex, .geminiCLI])
        #expect(clears.map(\.offset) == Array(clears[0].offset..<(clears[0].offset + 3)))
    }

    @Test func agentAndCategoryFilters() {
        let codex = CommandGuide.sections(data, filter: CommandFilter(agent: .codex))
        #expect(codex.allSatisfy { s in s.commands.allSatisfy { $0.agent == .codex } && s.custom.allSatisfy { $0.agent == .codex } })
        #expect(codex.first?.custom.map(\.name) == ["$api-docs", "$changelog", "/prompts:draft-pr"])

        let context = CommandGuide.sections(data, filter: CommandFilter(agent: .claudeCode, category: .context))
        // A category filter leaves out your commands (they have no category) and keeps that category's shell commands only.
        #expect(!context.contains { $0.kind == .custom })
        #expect(context.allSatisfy { s in s.commands.allSatisfy { $0.command.category == .context && $0.agent == .claudeCode } })
        #expect(names(context).contains("/compact"))

        #expect(CommandGuide.categories(data, agent: .claudeCode).contains(.context))
        #expect(CommandGuide.categories(data, agent: nil) == CommandGuide.categories(data, agent: nil).sorted())
    }

    @Test func runFilters() {
        let planned = CommandGuide.sections(data, filter: CommandFilter(run: .planned))
        #expect(!planned.isEmpty)
        #expect(planned.allSatisfy { s in s.custom.isEmpty && s.commands.allSatisfy { $0.command.signalbox.status == .planned } })
        #expect(names(planned).contains("/compact"))

        let shown = CommandGuide.sections(data, filter: CommandFilter(run: .shown))
        #expect(names(shown).contains("claude agents --json"))
        #expect(shown.allSatisfy { $0.commands.allSatisfy { $0.command.signalbox.status == .view } })

        let never = CommandGuide.sections(data, filter: CommandFilter(run: .notOffered))
        #expect(never.allSatisfy { $0.custom.isEmpty && $0.commands.allSatisfy { $0.command.signalbox.status == .never } })

        // Your own commands are run in the session, except Codex legacy prompts, which the CLI no longer loads:
        // those show only under Any.
        let inSession = CommandGuide.sections(data, filter: CommandFilter(run: .runInSession))
        #expect(inSession.first?.kind == .custom)
        let kept = inSession.first?.custom ?? []
        #expect(!kept.contains { $0.isLegacyPrompt })
        #expect(kept.count == data.custom.filter { !$0.isLegacyPrompt }.count)
        #expect(CommandGuide.sections(data, filter: CommandFilter(agent: .codex)).first?.custom.contains { $0.isLegacyPrompt } == true)
        let prompt = CustomCommand(agent: .codex, name: "/prompts:x", kind: .prompt)
        #expect(CommandRunFilter.any.keeps(prompt))
        #expect(!CommandRunFilter.runInSession.keeps(prompt))
        #expect(!CommandRunFilter.notOffered.keeps(prompt))
        #expect(CommandRunFilter.runInSession.keeps(CustomCommand(agent: .claudeCode, name: "/x")))
        #expect(CommandRunFilter.runInSession.keeps(.no))
        #expect(!CommandRunFilter.shown.keeps("someday"))
        #expect(CommandRunFilter.any.keeps("someday"))
    }

    @Test func searchRanksNamesFirst() throws {
        let hits = CommandGuide.sections(data, filter: CommandFilter(agent: .claudeCode, query: "compact"))
        let context = try #require(hits.first { $0.kind == .category(.context) })
        #expect(context.commands.first?.command.name == "/compact")
        #expect(context.commands.map(\.command.name).contains("/autocompact"))

        // The slash is optional, case doesn't matter, and every word must match somewhere.
        #expect(names(CommandGuide.sections(data, filter: CommandFilter(agent: .claudeCode, query: "  /COMPACT ")))
            == names(CommandGuide.sections(data, filter: CommandFilter(agent: .claudeCode, query: "compact"))))
        #expect(names(CommandGuide.sections(data, filter: CommandFilter(query: "compact frobnicate"))).isEmpty)

        // An alias finds its command: Claude Code's /cost is /usage.
        let cost = names(CommandGuide.sections(data, filter: CommandFilter(agent: .claudeCode, query: "/cost")))
        #expect(cost.first == "/usage")

        // Searching reaches your commands by description.
        let custom = CommandGuide.sections(data, filter: CommandFilter(query: "migrations"))
        #expect(custom.first?.custom.map(\.name) == ["/db:migrate-check"])

        #expect(CommandGuide.score(name: "/compact", aliases: [], text: [], query: "compact") == 0)
        #expect(CommandGuide.score(name: "/compress", aliases: ["/compact"], text: [], query: "compact") == 1)
        #expect(CommandGuide.score(name: "/compact", aliases: [], text: [], query: "comp") == 2)
        #expect(CommandGuide.score(name: "/autocompact", aliases: [], text: [], query: "compact") == 4)
        #expect(CommandGuide.score(name: "/clear", aliases: [], text: ["Use /compact instead"], query: "compact") == 5)
        #expect(CommandGuide.score(name: "/clear", aliases: [], text: [], query: "compact") == nil)
        #expect(CommandFilter(query: "   ").isSearching == false)
    }

    @Test func pluginNamesSplitTheirSharedLead() {
        let skill = CustomCommand(agent: .codex, name: "$acme-templates:report-quarterly", kind: .pluginSkill, scope: .plugin, source: "acme-templates")
        #expect(skill.nameParts.lead == "$acme-templates:")
        #expect(skill.nameParts.rest == "report-quarterly")
        let cmd = CustomCommand(agent: .claudeCode, name: "/acme-dev:lint-fix", kind: .pluginCommand, scope: .plugin, source: "acme-dev")
        #expect(cmd.nameParts.lead == "/acme-dev:" && cmd.nameParts.rest == "lint-fix")
        // Not a plugin, another plugin's prefix, or nothing after the lead: the whole name, no lead.
        for c in [CustomCommand(agent: .claudeCode, name: "/db:migrate-check", scope: .project),
                  CustomCommand(agent: .claudeCode, name: "/other:x", scope: .plugin, source: "acme"),
                  CustomCommand(agent: .claudeCode, name: "/acme:", scope: .plugin, source: "acme")] {
            #expect(c.nameParts.lead.isEmpty, "\(c.name)")
            #expect(c.nameParts.rest == c.name)
        }
    }

    @Test func rowsAreFoundByID() throws {
        let entry = try #require(CommandGuide.entries(data).first { $0.agent == .codex && $0.command.name == "/model" })
        #expect(CommandGuide.row(id: entry.id, in: data) == .builtIn(entry))
        let custom = try #require(data.custom.first)
        #expect(CommandGuide.row(id: custom.id, in: data) == .custom(custom))
        #expect(CommandGuide.row(id: "nope", in: data) == nil)
        #expect(CommandGuide.row(id: nil, in: data) == nil)
        // Ids are unique across the guide.
        let ids = CommandGuide.entries(data).map(\.id) + data.custom.map(\.id)
        #expect(Set(ids).count == ids.count)
    }

    @Test func copyPutsTheCommandAsTyped() throws {
        #expect(CommandGuide.copyText(CatalogCommand(name: "/compact", args: "[instructions]", summary: "")) == "/compact")
        #expect(CommandGuide.copyText(CatalogCommand(name: " claude agents --json ", summary: "")) == "claude agents --json")
        #expect(CommandGuide.copyText(CatalogCommand(name: "@<path>", summary: "")) == "@")
        #expect(CommandGuide.copyText(CatalogCommand(name: "!<command>", summary: "")) == "!")
        #expect(CommandGuide.copyText(CatalogCommand(name: "<weird>", summary: "")) == "<weird>")
        #expect(CommandGuide.copyText(CustomCommand(agent: .codex, name: "$changelog")) == "$changelog")
        #expect(CommandGuide.usage(CatalogCommand(name: "/compact", args: "[instructions]", summary: "")) == "/compact [instructions]")
        #expect(CommandGuide.usage(CatalogCommand(name: "/clear", args: " ", summary: "")) == "/clear")
        let entry = try #require(CommandGuide.entries(data).first { $0.command.name == "/compact" })
        #expect(GuideRow.builtIn(entry).copyText == "/compact")
    }

    @Test func versionNotes() {
        let catalog = CommandCatalog(agent: .codex, verifiedVersion: "0.161.0")
        #expect(CommandGuide.versionNote(catalog: catalog, installed: "0.161.0") == .matches("0.161.0"))
        #expect(CommandGuide.versionNote(catalog: catalog, installed: "0.162.1") == .differs(installed: "0.162.1", checked: "0.161.0"))
        #expect(CommandGuide.versionNote(catalog: catalog, installed: nil) == .notInstalled)
        #expect(CommandGuide.versionNote(catalog: nil, installed: "1.0") == .unchecked(installed: "1.0"))
    }

    @Test func catalogLookupPrefersOwnNamesOverAliases() throws {
        let gemini = try #require(data.catalog(for: .geminiCLI))
        #expect(gemini.command(["/compact", "/compress"])?.name == "/compress")
        let claude = try #require(data.catalog(for: .claudeCode))
        #expect(claude.command(["/compact", "/compress"])?.name == "/compact")
        #expect(claude.command(["/reset"])?.name == "/clear")
        #expect(claude.command(["/does-not-exist"]) == nil)
    }
}

@Suite("Session suggestions")
struct SessionSuggestionTests {
    let now = date("2026-10-09T14:30:00Z")
    let data: CommandsData

    init() throws {
        data = try TestPaths.loadCommands()
    }

    func session(_ agent: AgentID = .claudeCode, status: SessionStatus, since: TimeInterval = 60, tokens: Double? = nil, window: Double? = 1_000_000,
                 autoCompact: Double? = nil, waitingFor: String? = nil) -> FleetSession {
        FleetSession(agent: agent, sessionId: "s1", status: status, statusSince: now.addingTimeInterval(-since), waitingFor: waitingFor,
                     context: tokens.map { ContextSnapshot(agent: agent, sessionId: "s1", tokens: $0, window: window, autoCompactAtPercent: autoCompact, observedAt: now, quality: .official) })
    }

    @Test func highContextSuggestsCompact() throws {
        let s = SessionSuggestions.suggest(for: session(status: .idle, tokens: 780_000, autoCompact: 96.7), commands: data, now: now)
        #expect(s.map(\.kind) == [.compact])
        let compact = try #require(s.first)
        #expect(compact.command == "/compact")
        #expect(compact.reason == "Context 78% full · ≈780K of 1M · auto-compacts at 97%")
        #expect(compact.plannedNote != nil)
        // Below the threshold, nothing.
        #expect(SessionSuggestions.suggest(for: session(status: .idle, tokens: 740_000), commands: data, now: now).isEmpty)
    }

    @Test func aBusySessionIsToldToWaitForTheTurn() throws {
        let s = try #require(SessionSuggestions.suggest(for: session(status: .busy, tokens: 900_000), commands: data, now: now).first)
        #expect(s.detail.hasSuffix("Run it once the current turn finishes."))
    }

    @Test func aPermissionPromptIsAnsweredInTheSession() throws {
        let s = SessionSuggestions.suggest(for: session(status: .waiting, tokens: 100_000, waitingFor: "permission prompt"), commands: data, now: now)
        #expect(s.map(\.kind) == [.answer])
        let answer = try #require(s.first)
        #expect(answer.command == nil)
        #expect(answer.reason == "Answer it in the session")
        #expect(answer.detail.contains("permission prompt"))
        // Waiting with a full context: answer first, then compact.
        let both = SessionSuggestions.suggest(for: session(status: .waiting, tokens: 800_000, waitingFor: "input needed"), commands: data, now: now)
        #expect(both.map(\.kind) == [.answer, .compact])
        #expect(both[0].detail.contains("input needed"))
        // The command can't be typed until the prompt is answered.
        #expect(both[1].detail.hasSuffix("Answer the prompt first, then run it."))
        #expect(both[1].command == "/compact")
    }

    @Test func longIdleWithHighContextOffersCompactOrClear() {
        let idle = session(status: .idle, since: 2 * 3600, tokens: 600_000)
        let s = SessionSuggestions.suggest(for: idle, commands: data, now: now)
        #expect(s.map(\.kind) == [.compact, .clear])
        #expect(s.map(\.command) == ["/compact", "/clear"])
        #expect(s[0].reason == "Idle 2h with 60% of context in use")
        // Idle but not long enough, or long but with little context: nothing.
        #expect(SessionSuggestions.suggest(for: session(status: .idle, since: 20 * 60, tokens: 600_000), commands: data, now: now).isEmpty)
        #expect(SessionSuggestions.suggest(for: session(status: .idle, since: 3 * 3600, tokens: 300_000), commands: data, now: now).isEmpty)
    }

    @Test func codexAndGeminiGetTheirOwnCommands() {
        let codex = SessionSuggestions.suggest(for: session(.codex, status: .idle, since: 3 * 3600, tokens: 240_000, window: 272_000), commands: data, now: now)
        #expect(codex.map(\.command) == ["/compact", "/clear"])
        #expect(codex[0].reason.contains("≈240K of 272K"))
        #expect(codex[0].plannedNote == nil)
        let gemini = SessionSuggestions.suggest(for: session(.geminiCLI, status: .idle, tokens: 900_000), commands: data, now: now)
        #expect(gemini.map(\.command) == ["/compress"])
    }

    @Test func onlyCommandsFromTheCatalogAreSuggested() {
        let unknownAgent = session(AgentID(rawValue: "cursor-agent"), status: .idle, since: 3 * 3600, tokens: 900_000)
        #expect(SessionSuggestions.suggest(for: unknownAgent, commands: data, now: now).isEmpty)
        #expect(SessionSuggestions.suggest(for: session(status: .idle, tokens: 900_000), commands: nil, now: now).isEmpty)
        // A catalog without /compact suggests nothing for a full context.
        let bare = CommandsData(catalogs: [CommandCatalog(agent: .claudeCode, commands: [CatalogCommand(name: "/help", summary: "")])])
        #expect(SessionSuggestions.suggest(for: session(status: .idle, tokens: 900_000), commands: bare, now: now).isEmpty)
        // Without a guide, a waiting session still gets the hint.
        #expect(SessionSuggestions.suggest(for: session(status: .waiting, waitingFor: "permission prompt"), commands: nil, now: now).map(\.kind) == [.answer])
    }

    @Test func endedSessionsAndUnknownContextGetNothing() {
        #expect(SessionSuggestions.suggest(for: session(status: .ended, tokens: 990_000), commands: data, now: now).isEmpty)
        // Tokens without a window: no percent, so no context suggestion.
        #expect(SessionSuggestions.suggest(for: session(status: .idle, since: 9000, tokens: 990_000, window: nil), commands: data, now: now).isEmpty)
        #expect(SessionSuggestions.contextUsage(ContextSnapshot(agent: .codex, sessionId: "x", tokens: 1234, observedAt: now, quality: .estimated), percent: 0) == "≈1.23K tokens")
    }
}

@Suite("Navigation and redraw cadence")
struct NavigationOrderTests {
    @Test func sidebarOrderAndShortcuts() {
        #expect(SidebarSection.allCases == [.sessions, .history, .commands, .usage, .limits, .health])
        #expect(SidebarSection.allCases.map(\.shortcutKey) == ["1", "2", "3", "4", "5", "6"])
        #expect(SidebarSection.commands.title == "Commands")
        #expect(SidebarSection.history.title == "History")
        #expect(SidebarSection.history.systemImage == "clock.arrow.circlepath")
        #expect(SidebarSection(catalogView: "history") == .history)
        #expect(SidebarSection(catalogView: "usage") == .usage)
        #expect(SidebarSection(catalogView: "commands") == nil)
        #expect(SidebarSection(catalogView: nil) == nil)
    }

    @Test func relativeTimesRedrawFastOnlyUnderAMinute() {
        let now = date("2026-10-09T14:30:00Z")
        #expect(RefreshCadence.interval(now: now, anchors: []) == RefreshCadence.slow)
        #expect(RefreshCadence.interval(now: now, anchors: [now.addingTimeInterval(-30)]) == RefreshCadence.fast)
        #expect(RefreshCadence.interval(now: now, anchors: [now.addingTimeInterval(-60)]) == RefreshCadence.slow)
        #expect(RefreshCadence.interval(now: now, anchors: [now.addingTimeInterval(-3600), now.addingTimeInterval(20)]) == RefreshCadence.fast)
        #expect(RefreshCadence.slow == 30)
    }

    @Test func sessionsSubtitleLeavesOutZeroCounts() {
        #expect(Fmt.sessionCounts([.waiting: 0, .busy: 2, .idle: 0, .ended: 3]) == "2 busy")
        #expect(Fmt.sessionCounts([.waiting: 1, .busy: 2, .idle: 3]) == "1 waiting · 2 busy · 3 idle")
        #expect(Fmt.sessionCounts([.waiting: 0, .busy: 0, .idle: 0, .ended: 2]) == "2 ended")
        #expect(Fmt.sessionCounts([:]) == "")
        #expect(Fmt.sessionCounts([.idle: 1], convertedTo: "GBP") == "1 idle · costs in GBP at your rate")
    }
}
