import AppKit
import SignalboxKit
import SwiftUI

/// The Settings window (⌘,): General, Notifications, Display, Advanced.
struct SettingsView: View {
    @State private var tab: SettingsTab

    init(tab: SettingsTab = .general) {
        _tab = State(initialValue: tab)
    }

    var body: some View {
        TabView(selection: $tab) {
            ForEach(SettingsTab.allCases) { t in
                pane(t)
                    .frame(height: t.paneHeight)
                    .tabItem { Label(t.title, systemImage: t.systemImage) }
                    .tag(t)
            }
        }
        .frame(width: SettingsView.width)
        .tint(Theme.accent)
    }

    static let width: CGFloat = 580

    @ViewBuilder
    private func pane(_ t: SettingsTab) -> some View {
        switch t {
        case .general: GeneralSettingsPane()
        case .notifications: NotificationSettingsPane()
        case .display: DisplaySettingsPane()
        case .advanced: AdvancedSettingsPane()
        }
    }
}

/// A caption under a settings row.
private struct SettingsNote: View {
    let text: String
    var systemImage: String?
    var color: Color = .secondary

    init(_ text: String, systemImage: String? = nil, color: Color = .secondary) {
        self.text = text
        self.systemImage = systemImage
        self.color = color
    }

    var body: some View {
        Group {
            if let systemImage {
                Label {
                    Text(text)
                } icon: {
                    Image(systemName: systemImage).foregroundStyle(color)
                }
            } else {
                Text(text)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - General

private struct GeneralSettingsPane: View {
    @Environment(AppController.self) private var controller
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        let login = controller.launchAtLogin
        Form {
            Section("Startup") {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("Launch at login", isOn: Binding(get: { login.isOn }, set: { login.setEnabled($0) }))
                        .disabled(!login.canToggle)
                    SettingsNote(login.statusText, systemImage: login.needsApproval ? "exclamationmark.circle.fill" : nil, color: Theme.warning)
                    if login.needsApproval || login.status == .notFound {
                        Button("Open Login Items Settings…") { login.openSystemSettings() }
                            .controlSize(.small)
                    }
                    if let error = login.lastError {
                        SettingsNote(error, systemImage: "exclamationmark.triangle.fill", color: Theme.warning)
                    }
                }
                if let warning = login.locationWarning {
                    // Names the folder the app runs from.
                    SettingsNote(warning, systemImage: "info.circle", color: .secondary)
                        .privacySensitive()
                }
            }
            Section("Menu bar and Dock") {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("Show Dock icon", isOn: $settings.showDockIcon)
                    SettingsNote("When off, Signalbox lives in the menu bar only and starts without a window (macOS 15 and later). Open the window and Settings from the menu bar icon, or by opening Signalbox again.")
                }
                Picker("Menu bar shows", selection: $settings.menuBarLabel) {
                    ForEach(MenuBarLabelMode.allCases) { Text($0.title).tag($0) }
                }
                SettingsNote("Percentages come from fresh readings only (15 minutes or newer); otherwise the menu bar shows just the icon. Today's spend is the current report's figure for today.")
            }
        }
        .formStyle(.grouped)
        .onChange(of: settings.showDockIcon) { _, _ in controller.applyDockIcon() }
        .onAppear { login.refresh() }
    }
}

// MARK: - Notifications

private struct NotificationSettingsPane: View {
    @Environment(AppController.self) private var controller
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        let auth = controller.notifier.authorization
        Form {
            Section("Permission") {
                LabeledContent("Notifications") {
                    Label(statusText(auth), systemImage: statusSymbol(auth))
                        .foregroundStyle(auth.canPost ? Theme.ok : auth == .notDetermined ? Color.secondary : Theme.warning)
                }
                if case let .unavailable(reason) = auth {
                    SettingsNote(reason)
                } else if auth == .dryRun {
                    SettingsNote("SIGNALBOX_NOTIFY_DRYRUN is set: each notification is written to stderr as one \"notify …\" line and never shown.")
                } else if auth == .denied {
                    SettingsNote("Signalbox isn't allowed to show notifications. Turn them on in System Settings ▸ Notifications ▸ Signalbox.")
                }
                HStack {
                    if auth == .notDetermined {
                        Button("Turn On Notifications") { Task { await controller.notifier.requestAuthorization() } }
                            .buttonStyle(.borderedProminent)
                    }
                    Button("Open System Settings…") { SystemSettingsLinks.openNotifications() }
                    Spacer()
                    Button("Send Test Notification") { controller.notifications?.sendTest() }
                        .disabled(!auth.canPost)
                        .help(auth.canPost ? "Posts a test notification now" : "Allow notifications first")
                }
                .controlSize(.small)
            }
            Section("Notify me when") {
                VStack(alignment: .leading, spacing: 4) {
                    Toggle("A session needs you", isOn: $settings.notifyWaiting)
                    SettingsNote("Once each time a session starts waiting for your input. A session that was already waiting when Signalbox opened doesn't count.")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("A long task finishes", isOn: $settings.notifyLongTask)
                    Stepper(value: $settings.longTaskMinutes, in: SettingsStore.longTaskMinuteRange) {
                        Text("After at least \(settings.longTaskMinutes) \(settings.longTaskMinutes == 1 ? "minute" : "minutes") busy")
                            .monospacedDigit()
                    }
                    .disabled(!settings.notifyLongTask)
                    .padding(.leading, 20)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("A plan limit passes", isOn: $settings.notifyLimits)
                    HStack(spacing: 6) {
                        Text("Alert at")
                        thresholdField(0)
                        Text("% and")
                        thresholdField(1)
                        Text("%, once per window")
                    }
                    .disabled(!settings.notifyLimits)
                    .padding(.leading, 20)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Toggle("Signalbox can't read data", isOn: $settings.notifyCLIFailure)
                    SettingsNote("After the signalbox CLI has been failing or restarting for 2 minutes.")
                }
            }
            Section("Quiet") {
                VStack(alignment: .leading, spacing: 4) {
                    Toggle("Not for the session I'm looking at", isOn: $settings.quietWhenViewing)
                    SettingsNote("Skips a session's notifications while the Signalbox window is in front with that session selected.")
                }
                LabeledContent("Muted sessions") {
                    HStack {
                        Text(settings.mutes.isEmpty ? "None" : "\(settings.mutes.count)")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Button("Unmute All") { settings.unmuteAll() }
                            .controlSize(.small)
                            .disabled(settings.mutes.isEmpty)
                    }
                }
                SettingsNote("Mute a session from its inspector or its right-click menu, or from a notification. A mute lasts until the session ends.")
            }
        }
        .formStyle(.grouped)
        .task { await controller.notifier.refreshAuthorization() }
    }

    private func thresholdField(_ index: Int) -> some View {
        TextField("", value: Binding(get: { settings.limitThresholds[index] }, set: { settings.limitThresholds[index] = $0 }),
                  format: .number)
            .labelsHidden()
            .textFieldStyle(.roundedBorder)
            .multilineTextAlignment(.trailing)
            .monospacedDigit()
            .frame(width: 48)
            .accessibilityLabel(index == 0 ? "First alert percent" : "Second alert percent")
    }

    private func statusText(_ a: NotificationAuthorization) -> String {
        switch a {
        case .notDetermined: "Not asked yet"
        case .denied: "Off in System Settings"
        case .authorized: "Allowed"
        case .provisional: "Allowed quietly"
        case .unavailable: "Unavailable"
        case .dryRun: "Dry run (logged, not shown)"
        }
    }

    private func statusSymbol(_ a: NotificationAuthorization) -> String {
        switch a {
        case .authorized, .provisional: "checkmark.circle.fill"
        case .notDetermined: "questionmark.circle"
        case .dryRun: "terminal"
        case .denied, .unavailable: "exclamationmark.triangle.fill"
        }
    }
}

// MARK: - Display

private struct DisplaySettingsPane: View {
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        Form {
            Section("Currency") {
                Picker("Show amounts in", selection: $settings.currency) {
                    ForEach(DisplayCurrency.allCases) { Text($0.code).tag($0) }
                }
                .pickerStyle(.segmented)
                if settings.currency != .usd {
                    rateRow(settings.currency)
                    DatePicker("Rate as of", selection: asOfBinding(settings.currency), displayedComponents: .date)
                    if settings.currencyNeedsRate {
                        SettingsNote("Enter a rate to show amounts in \(settings.currency.code). Until then they stay in USD.", systemImage: "exclamationmark.circle.fill", color: Theme.warning)
                    }
                }
                SettingsNote("Prices are USD list prices. Other currencies are converted at your rate, and labelled \"converted at your rate\" wherever totals appear. Signalbox never fetches exchange rates.")
            }
            Section("Plan value") {
                LabeledContent("Monthly plan price") {
                    HStack(spacing: 6) {
                        TextField("", value: $settings.planPrice, format: .number.precision(.fractionLength(0...2)), prompt: Text("Not set"))
                            .labelsHidden()
                            .textFieldStyle(.roundedBorder)
                            .multilineTextAlignment(.trailing)
                            .monospacedDigit()
                            .frame(width: 90)
                        Picker("Currency", selection: $settings.planCurrency) {
                            ForEach(DisplayCurrency.allCases) { Text($0.code).tag($0) }
                        }
                        .labelsHidden()
                        .fixedSize()
                        Button("Clear") { settings.planPrice = nil }
                            .controlSize(.small)
                            .disabled(settings.planPrice == nil)
                    }
                }
                if settings.planCurrency != settings.currency, settings.planCurrency != .usd {
                    rateRow(settings.planCurrency)
                }
                if settings.plan != nil, settings.planCurrency != .usd, settings.rate(for: settings.planCurrency) == nil {
                    SettingsNote("Enter a \(settings.planCurrency.code) rate to compare a \(settings.planCurrency.code) plan with USD list prices.", systemImage: "exclamationmark.circle.fill", color: Theme.warning)
                }
                SettingsNote("Adds a tile to Usage: the last 30 days at list price compared with what you pay (\"≈ 4.2× your plan\"). It needs the 30-day range; a monthly price is never prorated.")
            }
        }
        .formStyle(.grouped)
    }

    private func rateRow(_ currency: DisplayCurrency) -> some View {
        LabeledContent("Your rate") {
            HStack(spacing: 6) {
                Text("1 USD =")
                    .foregroundStyle(.secondary)
                TextField("", value: Binding(get: { settings.rate(for: currency) }, set: { newValue in
                    settings.setRate(newValue, for: currency)
                    if newValue != nil, settings.rateAsOf(for: currency) == nil { settings.setRateAsOf(Date(), for: currency) }
                }), format: .number.precision(.fractionLength(0...4)), prompt: Text("rate"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .frame(width: 80)
                Text(currency.code)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func asOfBinding(_ currency: DisplayCurrency) -> Binding<Date> {
        Binding(get: { settings.rateAsOf(for: currency) ?? Date() }, set: { settings.setRateAsOf($0, for: currency) })
    }
}

// MARK: - Advanced

private struct AdvancedSettingsPane: View {
    @Environment(AppController.self) private var controller
    @Environment(SettingsStore.self) private var settings
    @State private var cliDraft = ""
    @State private var confirmReset = false

    var body: some View {
        @Bindable var settings = settings
        Form {
            Section("Signalbox CLI") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("CLI path")
                    TextField("", text: $cliDraft, prompt: Text("Empty: the CLI bundled in the app"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .font(.callout.monospaced())
                        .privacySensitive()
                        .onSubmit { if cliDraft.trimmingCharacters(in: .whitespaces) != settings.cliPathOverride { apply() } }
                }
                SettingsNote("A signalbox binary, or bun:/path/to/apps/cli/src/main.ts. Leave empty for the CLI inside the app. SIGNALBOX_CLI, when set in the environment, wins over this.")
                LabeledContent("Now running") {
                    Text(cliText)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .privacySensitive()
                }
                HStack {
                    Spacer()
                    Button("Use Bundled CLI") {
                        cliDraft = ""
                        apply()
                    }
                    .disabled(settings.cliPathOverride.isEmpty)
                    Button("Apply and Restart CLI") { apply() }
                        .disabled(cliDraft.trimmingCharacters(in: .whitespaces) == settings.cliPathOverride)
                }
                .controlSize(.small)
                .disabled(controller.isFixture)
            }
            Section("Session history") {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("Include the Claude app's session list", isOn: Binding(
                        get: { settings.includeClaudeAppSessions },
                        set: { controller.setIncludeClaudeAppSessions($0) }
                    ))
                    SettingsNote("History then matches the Claude app's list: the app's titles, its archived sessions (hidden until you ask), and sessions it lists whose transcripts aren't on this Mac. From each of the app's session files the CLI keeps only the title, folder, dates, ids, model, effort and archived flag, and drops the rest as soon as the file is parsed. Read-only: Signalbox never writes to the app's folder.")
                    SettingsNote("The app's session files are an internal format that can change without notice; Health shows whether they could be read. Changing this restarts the CLI.", systemImage: "exclamationmark.circle", color: .secondary)
                }
                .disabled(controller.isFixture)
            }
            Section("Troubleshooting") {
                HStack {
                    Button("Show Diagnostics") { controller.showDiagnostics() }
                    Spacer()
                    Button("Reset All Settings…", role: .destructive) { confirmReset = true }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { cliDraft = settings.cliPathOverride }
        .confirmationDialog("Reset all settings?", isPresented: $confirmReset) {
            Button("Reset All Settings", role: .destructive) {
                controller.resetSettings()
                cliDraft = settings.cliPathOverride
            }
        } message: {
            Text("Notification, display, menu bar, CLI and history settings go back to their defaults and muted sessions are unmuted. Launch at login stays as it is.")
        }
    }

    private func apply() {
        settings.cliPathOverride = cliDraft.trimmingCharacters(in: .whitespaces)
        Task { await controller.restartCLI() }
    }

    private var cliText: String {
        switch controller.cliLocation {
        case let .found(launch): return "\(launch.displayCommand) (\(launch.originDescription))"
        case let .missing(reason): return reason
        case nil: return controller.isFixture ? "None (showing a snapshot)" : "Locating…"
        }
    }
}
