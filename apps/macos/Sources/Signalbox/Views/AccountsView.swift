import SignalboxKit
import SwiftUI

/// Every account Signalbox has seen on this Mac, read-only: where each id came from, which config folder's terminal
/// login it is, its live and past sessions, and its plan windows. Renaming saves a label to Signalbox's own
/// accounts.json (the CLI, the web page and the menu bar use it); nothing agent-side is written.
struct AccountsView: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(\.money) private var money

    var body: some View {
        DataGate(value: store.fleet, waitingFor: "accounts") { _ in
            LiveNow(anchors: store.limits.flatMap { [$0.observedAt, $0.resetsAt] }) { now in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Accounts are told apart by a hash of the vendor's account and organization ids, never by email. A desktop session gets its account from the Claude app's session list; a terminal session from its transcript or, marked as inferred, from the current login of the config folder it runs from.")
                            .fixedSize(horizontal: false, vertical: true)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        if store.fleet?.accounts == nil {
                            ContentUnavailableView("Update the CLI", systemImage: "arrow.down.circle",
                                                   description: Text("This CLI doesn't report accounts yet."))
                        } else if store.accounts.isEmpty {
                            ContentUnavailableView("No account seen yet", systemImage: "person.2",
                                                   description: Text("Signalbox finds accounts in the Claude app's session list, in some transcript lines, and in each Claude Code config folder's login."))
                        } else {
                            logins
                            ForEach(store.accounts) { a in
                                AccountCard(account: a, now: now)
                            }
                            unknown
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner(scopes: [.fleet]) }
        .navigationTitle("Accounts")
        .navigationSubtitle(store.accounts.count == 1 ? "1 account" : "\(store.accounts.count) accounts")
        .toolbar { CommonToolbar() }
    }

    /// Which account each config folder's terminal login uses, and which accounts the Claude app's list has folders for.
    @ViewBuilder private var logins: some View {
        let dirs = store.accounts.flatMap { a in (a.loginConfigDirs ?? []).map { (dir: $0, id: a.id) } }.sorted { $0.dir < $1.dir }
        let app = store.accounts.filter { $0.claudeAppFolder == true }
        if !dirs.isEmpty || !app.isEmpty {
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(dirs, id: \.dir) { d in
                        LabeledContent {
                            Text(store.accountName(d.id))
                                .privacySensitive()
                        } label: {
                            Text(Fmt.shortPath(d.dir))
                                .font(.callout.monospaced())
                                .help("The terminal login in this Claude Code config folder")
                                .privacySensitive()
                        }
                    }
                    if !app.isEmpty {
                        LabeledContent {
                            Text(app.map { store.accountName($0.id) }.joined(separator: ", "))
                                .privacySensitive()
                        } label: {
                            Text("Claude app (desktop)")
                                .help("The Claude app keeps a session folder per account it was signed in as")
                        }
                    }
                }
                .padding(6)
            } label: {
                Text("Current logins").font(.headline)
            }
        }
    }

    /// Sessions with no account: counted, never given a default one.
    @ViewBuilder private var unknown: some View {
        let (live, past) = store.unknownAccountCounts
        if live + past > 0 {
            Label {
                Text("Account unknown: \(live) live and \(past) past Claude Code \(live + past == 1 ? "session" : "sessions"). Nothing on this Mac names their account, and a desktop session runs on the Claude app's own login, so no folder login applies.")
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "questionmark.circle")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        }
    }
}

private struct AccountCard: View {
    @Environment(SignalboxStore.self) private var store
    @Environment(\.money) private var money
    let account: AccountInfo
    let now: Date
    @State private var draft = ""
    @State private var editing = false
    @State private var error: String?

    var body: some View {
        let name = store.accountName(account.id)
        let past = (store.history?.entries ?? []).filter { $0.account?.id == account.id }
        let cost = HistoryBrowser.totalCost(past)
        let groups = store.limitAgents.flatMap { store.limitGroups(for: $0) }.filter { $0.account?.id == account.id }
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                if editing {
                    HStack {
                        TextField("Label", text: $draft, prompt: Text("e.g. Max, Team"))
                            .textFieldStyle(.roundedBorder)
                            .onSubmit(save)
                        Button("Save", action: save)
                            .keyboardShortcut(.defaultAction)
                        Button("Cancel") { editing = false }
                    }
                    if let error {
                        Text(error).font(.caption).foregroundStyle(Theme.critical)
                    }
                }
                LabeledContent("Named by") {
                    Text(account.sources.map(AccountNaming.sourceText).joined(separator: ", "))
                        .multilineTextAlignment(.trailing)
                }
                if !account.orgKnown {
                    Label("Only the account half of this id was found, so its plan limits can't be told apart from its other organizations'.", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(Theme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                LabeledContent("Live sessions") {
                    Text("\(account.liveSessions ?? 0)").monospacedDigit()
                }
                LabeledContent("In History") {
                    Text(past.isEmpty ? "None" : "\(past.count) \(past.count == 1 ? "session" : "sessions")\(cost.map { " · \(money.amount($0))" } ?? "")")
                        .monospacedDigit()
                        .help(Fmt.listPriceNote)
                }
                if !groups.isEmpty {
                    Divider()
                    HStack(alignment: .ringCenter, spacing: 12) {
                        ForEach(groups) { g in
                            ForEach(g.limits) { l in
                                LimitRing(limit: l, state: store.limitState(l, now: now), now: now, captionWidth: 76)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 8) {
                Text(name)
                    .font(.headline)
                    .privacySensitive()
                Text(account.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Spacer()
                if !editing {
                    Button("Rename…") {
                        draft = store.accountLabels[account.id] ?? account.label ?? ""
                        error = nil
                        editing = true
                    }
                    .controlSize(.small)
                }
            }
        }
    }

    private func save() {
        do {
            try store.renameAccount(account.id, to: draft)
            editing = false
        } catch {
            self.error = "Couldn't save the label: \(error.localizedDescription)"
        }
    }
}
