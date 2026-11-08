import Foundation
import SignalboxKit

// The shell text signalbox-switch writes: the `claude` shim, one-shot resume scripts, and the undo script for the
// shared-sessions setup (which you run yourself). Every value goes into the text single-quoted.

private func q(_ s: String) -> String { HistoryBrowser.shellQuote(s) }

public enum ShimScript {
    /// On the second line of the shim, so a PATH search (the shim's own, the CLI's, the app's) can tell a copy of
    /// it from the real `claude` by reading two lines.
    public static let marker = "# signalbox-switch shim"

    /// The shim: picks the config folder (an explicit CLAUDE_CONFIG_DIR, else the choice an outer run passed on, else
    /// the pointer, else the default), passes the choice on, then `exec`s the first other `claude` on PATH.
    public static func text(pointerPath: String) -> String {
        """
        #!/bin/sh
        \(marker) (written by Signalbox; your edits are overwritten). Unofficial.
        set -f
        pointer=\(q(pointerPath))
        here=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)

        if [ -z "${CLAUDE_CONFIG_DIR-}" ]; then
          if [ -n "${SIGNALBOX_SWITCH_CHOSEN-}" ]; then choice=$SIGNALBOX_SWITCH_CHOSEN   # an outer run chose
          elif [ -e "$pointer" ]; then choice=; IFS= read -r choice < "$pointer"
          else choice=default
          fi
          case $choice in
            default) unset CLAUDE_CONFIG_DIR ;;
            /*) if [ -d "$choice" ] && [ -O "$choice" ]; then CLAUDE_CONFIG_DIR=$choice; export CLAUDE_CONFIG_DIR
                else echo "signalbox-switch: $choice isn't a folder you own." >&2
                     echo "Pick an account in Signalbox, or delete $pointer to use your default." >&2; exit 1; fi ;;
            *) echo "signalbox-switch: can't read $pointer. Pick an account in Signalbox, or delete it." >&2; exit 1 ;;
          esac
        fi
        # Pass the choice on, so a nested claude keeps it even if the pointer changes or the variable is scrubbed.
        case ${CLAUDE_CONFIG_DIR-} in
          '') SIGNALBOX_SWITCH_CHOSEN=default; export SIGNALBOX_SWITCH_CHOSEN ;;
          /*) SIGNALBOX_SWITCH_CHOSEN=$CLAUDE_CONFIG_DIR; export SIGNALBOX_SWITCH_CHOSEN ;;
        esac

        real=${SIGNALBOX_REAL_CLAUDE-}
        if [ -z "$real" ]; then
          IFS=:
          for d in $PATH; do
            [ -n "$d" ] || continue
            [ "$(CDPATH= cd -P -- "$d" 2>/dev/null && pwd -P)" = "$here" ] && continue
            [ -f "$d/claude" ] && [ -x "$d/claude" ] || continue
            head -n 2 "$d/claude" 2>/dev/null | grep -q '^\(marker)' && continue
            real=$d/claude; break
          done
          unset IFS
        fi
        [ -n "$real" ] || { echo "signalbox-switch: no claude found on PATH besides this shim." >&2; exit 127; }
        exec "$real" "$@"

        """
    }

    /// True when the first two lines of `head` carry the marker.
    public static func isShim(head: Data) -> Bool {
        let text = String(decoding: head.prefix(512), as: UTF8.self)
        return text.split(separator: "\n", maxSplits: 2, omittingEmptySubsequences: false).prefix(2).contains { $0.hasPrefix(marker) }
    }

    /// The lines you paste into your shell profile (Signalbox never edits it).
    public static func functionLines(shimPath: String) -> String {
        "unalias claude 2>/dev/null\nfunction claude { \(q(shimPath)) \"$@\"; }"
    }

    public static func fishFunction(shimPath: String) -> String {
        "function claude; \(fishQuote(shimPath)) $argv; end"
    }

    public static func pathLine(binDir: String) -> String {
        "export PATH=\(q(binDir))\":$PATH\""
    }

    /// fish single quotes: only \ and ' are special inside.
    static func fishQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'"
    }
}

/// One "Resume with" request, after the checks.
public struct ResumeRequest: Hashable, Sendable {
    public var sessionId: String
    /// The folder to `cd` into; nil when there is none or it is gone.
    public var cwd: String?
    public var folder: SwitchFolder
    /// `--fork-session`: a new session id from a copy, the original left as it is.
    public var fork: Bool
    /// The real `claude`, never the shim.
    public var claudePath: String

    public init(sessionId: String, cwd: String?, folder: SwitchFolder, fork: Bool, claudePath: String) {
        self.sessionId = sessionId
        self.cwd = cwd
        self.folder = folder
        self.fork = fork
        self.claudePath = claudePath
    }

    /// Core's SAFE_ID: ids that are safe in a shell line even unquoted.
    public static func isSafeID(_ id: String) -> Bool {
        id.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"#, options: .regularExpression) != nil
    }

    var isFit: Bool {
        Self.isSafeID(sessionId) && isCleanPath(claudePath) && claudePath.hasPrefix("/") && isCleanPath(folder.path)
            && (cwd.map { isCleanPath($0) && $0.hasPrefix("/") } ?? true)
    }

    private var arguments: String {
        "--resume \(q(sessionId))" + (fork ? " --fork-session" : "")
    }

    /// The script Terminal runs: it deletes itself, then `cd`, the folder's environment, and `exec` of claude.
    public var script: String? {
        guard isFit else { return nil }
        var lines = [
            "#!/bin/sh",
            "# signalbox-switch resume script: deletes itself, then resumes one session. Unofficial.",
            "rm -f -- \"$0\"",
        ]
        if let cwd { lines.append("cd -- \(q(cwd)) || exit 1") }
        if folder.isDefault {
            lines.append("unset CLAUDE_CONFIG_DIR")
            lines.append("SIGNALBOX_SWITCH_CHOSEN=default; export SIGNALBOX_SWITCH_CHOSEN")
        } else {
            lines.append("CLAUDE_CONFIG_DIR=\(q(folder.path)); export CLAUDE_CONFIG_DIR")
            lines.append("SIGNALBOX_SWITCH_CHOSEN=\(q(folder.path)); export SIGNALBOX_SWITCH_CHOSEN")
        }
        lines.append("exec \(q(claudePath)) \(arguments)")
        return lines.joined(separator: "\n") + "\n"
    }

    /// The same command on one line, for the confirm sheet.
    public var displayCommand: String? {
        guard isFit else { return nil }
        let env = folder.isDefault ? "env -u CLAUDE_CONFIG_DIR" : "CLAUDE_CONFIG_DIR=\(q(folder.path))"
        let run = "\(env) \(q(claudePath)) \(arguments)"
        return cwd.map { "cd \(q($0)) && \(run)" } ?? run
    }
}

/// The script that reverses one shared-sessions setup, for you to run: it removes the link (only if it still points at
/// the shared tree), moves every logged entry back, and removes the folders the setup created once they are empty.
/// Before the link step ran, it checks every original place first and changes nothing if one is taken. Sessions
/// created after the setup are new entries, so they stay in the shared tree.
public enum UndoScript {
    /// nil when the run moved nothing, or when a logged path can't go into a script safely.
    public static func text(secondFolder: String, sharedTree: String?, moves: [AuditMove], created: [String] = [], run: String, at: Date) -> String? {
        guard !moves.isEmpty, isCleanPath(secondFolder), sharedTree.map(isCleanPath) ?? true,
              moves.allSatisfy({ isCleanPath($0.from) && isCleanPath($0.to) }), created.allSatisfy(isCleanPath) else { return nil }
        var lines = [
            "#!/bin/sh",
            "# Undoes signalbox-switch's shared-sessions setup of \(secondFolder) (run \(run), \(AuditEntry.timestamp(at))). Unofficial.",
            "# Quit Claude Code in every folder first. Sessions created after the setup stay in \(sharedTree ?? "the shared tree").",
            "set -u",
            "link=\(q(secondFolder + "/projects"))",
            "if [ -L \"$link\" ]; then",
        ]
        if let sharedTree {
            lines.append("  [ \"$(readlink \"$link\")\" = \(q(sharedTree)) ] || { echo \"undo: $link points somewhere else now; nothing was changed.\" >&2; exit 1; }")
        }
        lines += [
            "  rm -- \"$link\" || exit 1",
            "else",
            "  # The link step never ran: every original place must be free before anything moves.",
            "  taken=0",
        ]
        for m in moves { lines.append("  if [ -e \(q(m.from)) ] || [ -L \(q(m.from)) ]; then echo \(q("undo: \(m.from) already exists")) >&2; taken=1; fi") }
        lines += [
            "  [ \"$taken\" = 0 ] || { echo \"undo: nothing was changed. Move those aside, then run this again.\" >&2; exit 1; }",
            "fi",
            "back() {",
            "  if [ -e \"$2\" ] || [ -L \"$2\" ]; then echo \"undo: $2 already exists; stopping before moving $1 back.\" >&2; exit 1; fi",
            "  if [ ! -e \"$1\" ] && [ ! -L \"$1\" ]; then echo \"undo: $1 is gone; skipping it.\" >&2; return 0; fi",
            "  mkdir -p -- \"$(dirname -- \"$2\")\" && mv -- \"$1\" \"$2\" || exit 1",
            "}",
        ]
        for m in moves.reversed() { lines.append("back \(q(m.to)) \(q(m.from))") }
        for d in created.reversed() { lines.append("rmdir -- \(q(d)) 2>/dev/null") }
        lines.append("echo \(q("Undone. Check \(secondFolder) before starting Claude Code there."))")
        return lines.joined(separator: "\n") + "\n"
    }
}
