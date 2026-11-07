import SignalboxKit
import SwiftUI

/// A small chip with the account's name (your label, else its short id). An inferred account (a config dir's current
/// login) is drawn with a dashed outline. Nothing is drawn for an unknown account: rows stay quiet, and the inspector
/// says "Account unknown".
struct AccountChip: View {
    @Environment(SignalboxStore.self) private var store
    let account: AccountRef?

    var body: some View {
        if let account {
            let name = store.accountName(account.id)
            Text(name)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 110, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .foregroundStyle(Theme.accent)
                .background(account.isInferred ? Color.clear : Theme.accent.opacity(0.12), in: Capsule())
                .overlay {
                    if account.isInferred {
                        Capsule().strokeBorder(Theme.accent.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                    }
                }
                .help(AccountNaming.help(account, name: name))
                .accessibilityLabel("Account \(name)\(account.isInferred ? ", inferred" : "")")
                .privacySensitive()
        }
    }
}

/// The inspector's account line: the name and short id, where it came from, or "Account unknown" and why.
struct AccountDetail: View {
    @Environment(SignalboxStore.self) private var store
    let account: AccountRef?
    var conflict = false
    /// Desktop sessions run on the Claude app's own login, so no folder login is inferred for them.
    var entrypoint: String?

    var body: some View {
        LabeledContent("Account") {
            VStack(alignment: .trailing, spacing: 3) {
                if let account {
                    HStack(spacing: 6) {
                        AccountChip(account: account)
                        Text(account.shortID)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    Text(source(account))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                    if conflict {
                        Text("Its files name more than one account (resumed under the other one?); the newest is shown.")
                            .font(.caption)
                            .foregroundStyle(Theme.warning)
                            .multilineTextAlignment(.trailing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text("Unknown")
                        .foregroundStyle(.tertiary)
                    Text(unknownReason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func source(_ a: AccountRef) -> String {
        let base = a.isInferred ? "Inferred from \(AccountNaming.sourceText(a.source))" : "From \(AccountNaming.sourceText(a.source))"
        return a.orgKnown ? base : "\(base); organization unknown"
    }

    private var unknownReason: String {
        entrypoint == "claude-desktop"
            ? "Nothing on this Mac names it: the Claude app's list doesn't have this session, and its transcript has no account line."
            : "Nothing on this Mac names it, and no config dir's login applies."
    }
}
