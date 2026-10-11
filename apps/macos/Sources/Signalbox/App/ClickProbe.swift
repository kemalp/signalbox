import AppKit
import SignalboxKit

/// Diagnostics for list selection in the running app (SIGNALBOX_CLICK_PROBE=1, see scripts/click-probe.sh).
/// It sends the app's own window real mouse events (in-process, so no Accessibility permission is needed):
/// a click on each sidebar row, then on the first session row, the first history row and the first command row, then
/// opens About from the app menu, then flips Settings ▸ Advanced ▸ "Include the Claude app's session list" off, on and
/// off without waiting (the CLI must end up as one child with the last setting), and prints one RESULT line to stderr.
@MainActor
enum ClickProbe {
    static func runIfRequested(_ controller: AppController) {
        guard ProcessInfo.processInfo.environment["SIGNALBOX_CLICK_PROBE"] == "1" else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            await run(controller)
        }
    }

    private static func log(_ s: String) { FileHandle.standardError.write(Data("probe: \(s)\n".utf8)) }

    private static func tables(in view: NSView) -> [NSTableView] {
        var out: [NSTableView] = []
        if let t = view as? NSTableView { out.append(t) }
        for s in view.subviews { out += tables(in: s) }
        return out
    }

    /// `inset`: click this far from the row's leading edge instead of its middle (a History row has a Live button
    /// in the middle of some titles, which navigates instead of selecting).
    private static func click(_ table: NSTableView, row: Int, in window: NSWindow, inset: CGFloat? = nil) {
        guard window.isKeyWindow else {
            // A window that can't become key (another app holds focus, or the screen is locked) only uses a click to
            // come forward. Select the row through the table instead: that still checks the List's tags reach its
            // selection binding, though not the hit-testing a real click adds.
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            return
        }
        let r = table.convert(table.rect(ofRow: row), to: nil)
        let p = NSPoint(x: inset.map { r.minX + $0 } ?? r.midX, y: r.midY)
        func event(_ type: NSEvent.EventType) -> NSEvent? {
            NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        }
        // The table's mouse tracking loop pulls the mouse-up from the queue, so queue it before the mouse-down.
        if let up = event(.leftMouseUp), let down = event(.leftMouseDown) {
            NSApp.postEvent(up, atStart: false)
            window.sendEvent(down)
        }
    }

    /// This process's `signalbox watch` children, as `ps` lists them: their command lines.
    private static func watchChildren() -> [String] {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-A", "-o", "ppid=,command="]
        let pipe = Pipe()
        ps.standardOutput = pipe
        ps.standardError = FileHandle.nullDevice
        do { try ps.run() } catch { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        ps.waitUntilExit()
        let me = getpid()
        return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { line -> String? in
            let t = line.trimmingCharacters(in: .whitespaces)
            guard let space = t.firstIndex(of: " "), Int32(t[..<space]) == me else { return nil }
            let command = t[space...].trimmingCharacters(in: .whitespaces)
            return command.contains(" watch --ndjson") ? command : nil
        }
    }

    /// Quick toggles of the Claude app list switch: restarts must not overlap (an overlap left a second CLI running,
    /// reading the app's list after it was turned off). Ends on "off": one child with --no-claude-app, and a history
    /// built without the list.
    private static func restarts(_ controller: AppController) async -> String {
        guard !controller.isFixture, controller.store.connection.isLive else { return "skipped (no live CLI)" }
        controller.setIncludeClaudeAppSessions(false)
        controller.setIncludeClaudeAppSessions(true)
        controller.setIncludeClaudeAppSessions(false)
        var children: [String] = []
        var steady = 0
        for _ in 0..<40 where steady < 3 { // up to 20 s for the old children to go
            try? await Task.sleep(for: .milliseconds(500))
            children = watchChildren()
            steady = children.count == 1 && children[0].hasSuffix(" --no-claude-app") ? steady + 1 : 0
        }
        for _ in 0..<90 where controller.store.history?.sources?.claudeApp?.enabled != false { // up to 45 s
            try? await Task.sleep(for: .milliseconds(500))
        }
        children = watchChildren()
        let flags = children.map { $0.hasSuffix(" --no-claude-app") ? "off" : "on" }
        let app = controller.store.history?.sources?.claudeApp.map { $0.enabled ? "on" : "off" } ?? "none"
        log("restarts: watch children=\(children.count) flags=\(flags) history claudeApp=\(app) setting=\(controller.settings.includeClaudeAppSessions ? "on" : "off")")
        guard children.count == 1, flags == ["off"] else { return "fail (\(children.count) watch children, flags \(flags))" }
        return app == "off" ? "ok" : "fail (history claudeApp=\(app))"
    }

    private static func run(_ controller: AppController) async {
        guard let window = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix(WindowID.main) == true }),
              let root = window.contentView?.superview ?? window.contentView else {
            log("RESULT sidebar=fail sessions=skipped (no main window)")
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        let nav = controller.navigation
        let leftmost = { tables(in: root).min { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX } }
        guard let sidebar = leftmost() else {
            log("RESULT sidebar=fail sessions=skipped (no sidebar list)")
            return
        }

        // A click on a background window only brings it forward (as for a person), so get key status first.
        for i in 0..<25 where !window.isKeyWindow {
            if i % 5 == 4 {
                NSApp.activate()
                window.makeKeyAndOrderFront(nil)
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        log("windows=\(NSApp.windows.filter(\.isVisible).compactMap { $0.identifier?.rawValue }.filter { !$0.isEmpty }.sorted())")
        log("window key=\(window.isKeyWindow)\(window.isKeyWindow ? "" : " (can't become key: rows are selected through the tables, not clicked)")")

        // Sidebar: rows are the "Signalbox" header, then one row per section in order.
        var sidebarOK = sidebar.selectedRow == 1 && nav.section == .sessions
        log("initial section=\(String(describing: nav.section)) selectedRow=\(sidebar.selectedRow)")
        for (offset, expected) in SidebarSection.allCases.enumerated().reversed() {
            let current = leftmost() ?? sidebar
            if current !== sidebar { log("note: sidebar table was replaced") }
            click(current, row: offset + 1, in: window)
            try? await Task.sleep(for: .milliseconds(600))
            let ok = nav.section == expected
            sidebarOK = sidebarOK && ok
            let fresh = leftmost()
            log("click sidebar row \(offset + 1) -> section=\(String(describing: nav.section)) expected=\(expected) \(ok ? "ok" : "FAIL") selectedRow=\(fresh?.selectedRow ?? -9) firstResponder=\(window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil") key=\(window.isKeyWindow) sheets=\(window.sheets.count)")
        }

        // Sessions: back on Sessions, click the first selectable session row.
        try? await Task.sleep(for: .milliseconds(600))
        var sessions = "skipped (no sessions)"
        let side = leftmost() ?? sidebar
        if let list = tables(in: root).first(where: { $0 !== side && $0.convert($0.bounds, to: nil).minX > 100 }), list.numberOfRows > 0 {
            nav.selectedSessionID = nil
            for row in 0..<min(list.numberOfRows, 4) {
                click(list, row: row, in: window)
                try? await Task.sleep(for: .milliseconds(500))
                if nav.selectedSessionID != nil { break }
            }
            sessions = nav.selectedSessionID != nil ? "ok" : "fail"
            log("session list rows=\(list.numberOfRows) selected=\(nav.selectedSessionID != nil) selectedRow=\(list.selectedRow)")
        }

        // History: open it from the sidebar, wait for the first history line (it follows the CLI's first transcript
        // scan), and click the first selectable row near its leading edge (rows start with a day header).
        var history = "skipped (no history)"
        if let side = leftmost(), let row = SidebarSection.allCases.firstIndex(of: .history) {
            click(side, row: row + 1, in: window)
            try? await Task.sleep(for: .milliseconds(800))
            for _ in 0..<60 where (controller.store.history?.entries.isEmpty ?? true) {
                try? await Task.sleep(for: .milliseconds(500))
            }
            // The list, not the inspector: the leftmost table right of the sidebar.
            let list = tables(in: root).filter { $0 !== side && $0.convert($0.bounds, to: nil).minX > 100 }
                .min { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }
            if nav.section != .history {
                history = "fail (History didn't open)"
            } else if controller.store.history == nil {
                history = "skipped (no history from the CLI within 30 s)"
            } else if let list, list.numberOfRows > 0 {
                nav.selectedHistoryID = nil
                for row in 0..<min(list.numberOfRows, 4) {
                    click(list, row: row, in: window, inset: 24)
                    try? await Task.sleep(for: .milliseconds(500))
                    if nav.selectedHistoryID != nil || nav.section != .history { break }
                }
                history = nav.selectedHistoryID != nil && nav.section == .history ? "ok" : "fail"
                log("history list rows=\(list.numberOfRows) entries=\(controller.store.history?.entries.count ?? 0) selected=\(nav.selectedHistoryID != nil) section=\(String(describing: nav.section)) selectedRow=\(list.selectedRow)")
            } else if controller.store.history?.entries.isEmpty == true {
                history = "skipped (no sessions in the history)"
            } else {
                history = "fail (no history list)"
            }
        }

        // Commands: open it from the sidebar and click the first selectable command row (rows start with a header).
        var commands = "skipped (no command guide)"
        if let side = leftmost(), let row = SidebarSection.allCases.firstIndex(of: .commands) {
            click(side, row: row + 1, in: window)
            try? await Task.sleep(for: .milliseconds(1200))
            if nav.section == .commands, controller.store.commands != nil,
               let list = tables(in: root).first(where: { $0 !== side && $0.convert($0.bounds, to: nil).minX > 100 }), list.numberOfRows > 0 {
                nav.selectedCommandID = nil
                for row in 0..<min(list.numberOfRows, 4) {
                    click(list, row: row, in: window)
                    try? await Task.sleep(for: .milliseconds(500))
                    if nav.selectedCommandID != nil { break }
                }
                commands = nav.selectedCommandID != nil ? "ok" : "fail"
                log("command list rows=\(list.numberOfRows) selected=\(nav.selectedCommandID != nil) selectedRow=\(list.selectedRow)")
            } else if nav.section != .commands {
                commands = "fail (Commands didn't open)"
            }
        }
        // About: the app menu's item opens the About window (a SwiftUI Window scene).
        var about = "fail (no About item)"
        if let appMenu = NSApp.mainMenu?.items.first?.submenu,
           let index = appMenu.items.firstIndex(where: { $0.title == "About Signalbox" }) {
            appMenu.performActionForItem(at: index)
            try? await Task.sleep(for: .milliseconds(800))
            let shown = NSApp.windows.first { $0.isVisible && $0.identifier?.rawValue.hasPrefix(WindowID.about) == true }
            about = shown != nil ? "ok" : "fail (no About window)"
            shown?.close()
        }
        let restart = await restarts(controller)
        log("RESULT sidebar=\(sidebarOK ? "ok" : "fail") sessions=\(sessions) history=\(history) commands=\(commands) about=\(about) restart=\(restart)")
    }
}
