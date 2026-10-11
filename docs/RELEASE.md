# Releasing Signalbox

A release is three local files: the arm64 app (with the `signalbox` CLI inside) in a zip, its SHA-256, and a
filled-in Homebrew cask. `apps/macos/scripts/release.sh` makes them. **No script uploads, tags, commits or pushes
anything**: publishing is a manual step, described below.

> **Status:** the app is **ad-hoc signed and not notarized**. macOS blocks its first launch on any Mac that
> downloads it, and Homebrew's caveat says how to allow it. Notarization is described under
> [Notarization (not done)](#notarization-not-done). None of it has been set up.

## The version

`VERSION` at the repo root is the single source (plain `X.Y.Z`; the app's `CFBundleShortVersionString` allows
nothing else). The `"version"` fields of the six `package.json` files and the workspace entries in `bun.lock` are
copies, because those files can't read another file:

```sh
packaging/version.sh                 # print it
packaging/version.sh set 0.2.0       # write VERSION and update every copy
packaging/version.sh check           # fail if any copy disagrees
packaging/version.sh check --app path/to/Signalbox.app   # also the bundle version and the bundled CLI's --version
```

- The CLI's `--version` (and the `version` in the watch stream's `hello` line) comes from `apps/cli/package.json`,
  which `set` keeps in step. `bun test` fails when a `package.json` or `bun.lock` copy disagrees with `VERSION`
  (`apps/cli/test/version.test.ts`).
- The app's `CFBundleShortVersionString` is stamped from `VERSION` by `apps/macos/scripts/build-app.sh`, and the
  About window shows it next to the CLI version from `hello`. `release.sh` refuses to package an app whose bundle
  version or bundled CLI disagrees with `VERSION`, so a mismatch can't ship.
- The signalbox-tap plugin (`plugins/signalbox-tap/.claude-plugin/plugin.json`) has its own version, separate from
  the app's. Bump it only when the plugin changes.

## Cut a release

1. Set the version: `packaging/version.sh set 0.2.0`.
2. Run the checks: `bun test`, `bun run typecheck`, `bun apps/cli/scripts/reference-check.ts --days 7`, and
   `cd apps/macos && swift test`.
3. Commit, then tag by hand: `git tag -a v0.2.0 -m "Signalbox 0.2.0"`.
4. Package: `apps/macos/scripts/release.sh`. It writes into `dist/release/` (ignored by git):
   - `Signalbox-0.2.0-macos-arm64.zip`
   - `Signalbox-0.2.0-macos-arm64.zip.sha256`
   - `signalbox.rb`, the cask
5. Optional smoke test of the packaged app on synthetic data (opens a test copy's window for about 15 s):
   ```sh
   mkdir /tmp/sb-check && ditto -x -k dist/release/Signalbox-0.2.0-macos-arm64.zip /tmp/sb-check
   apps/macos/scripts/notify-dryrun.sh /tmp/sb-check/Signalbox.app
   ```
6. Publish (by hand): push the tag, then attach the zip and the `.sha256` to a GitHub release, for example
   `gh release create v0.2.0 dist/release/Signalbox-0.2.0-macos-arm64.zip dist/release/Signalbox-0.2.0-macos-arm64.zip.sha256`.
   The repo is private: Homebrew and other people can't download its release assets until it is public, or until
   the zip is hosted somewhere public (pass that folder as `--url-base`).
7. Homebrew (by hand): copy `dist/release/signalbox.rb` into a tap repo as `Casks/signalbox.rb`. With a repo named
   `<owner>/homebrew-tap`, people install with `brew install --cask <owner>/tap/signalbox`. That tap repo does not
   exist yet.

### release.sh

```sh
apps/macos/scripts/release.sh                   # refuses when git shows uncommitted or untracked changes
apps/macos/scripts/release.sh --allow-dirty     # package them anyway; the summary says DIRTY
apps/macos/scripts/release.sh --output DIR      # write into DIR instead of dist/release
apps/macos/scripts/release.sh --url-base URL    # the folder the zip will be downloaded from (https:// or file:///)
apps/macos/scripts/release.sh --homepage URL    # the cask's homepage (https://)
```

The defaults come from the GitHub repo that the `origin` remote points to, so no account name is written into the
script: `--url-base` is `https://github.com/<owner>/<repo>/releases/download/v#{version}` (Homebrew fills in
`#{version}`) and `--homepage` is `https://github.com/<owner>/<repo>`. When `origin` is not a plain GitHub URL, the
script stops and asks for both. In order, the script:

1. Reads `VERSION` and checks the copies (`packaging/version.sh check`).
2. Checks git with read-only commands (`status --no-optional-locks`, `rev-parse`, `tag --points-at`). Untracked
   files count as changes, since some of them (price tables, command catalogs) get embedded in the CLI.
3. Always rebuilds `dist/signalbox` (build-app.sh's own staleness check goes by file times and can miss new
   embedded data), then runs `build-app.sh --output <temp folder>`, so `apps/macos/build` is left alone.
4. Checks the bundle: both executables present and arm64-only, the icon present, `codesign --verify --strict
   --deep` passes, and the bundle version and the bundled CLI's `--version` both equal `VERSION`.
5. Zips with `ditto -c -k --norsrc --keepParent`. Without `--norsrc`, ditto stores extended attributes (build
   machines tag files with `com.apple.provenance`) as `._` entries. `unzip` turns those into stray files inside the
   bundle, and then the signature fails with "a sealed resource is missing or invalid". The script fails if the zip
   holds anything outside `Signalbox.app/` or any `._`/`__MACOSX` entry.
6. Writes the `.sha256` (the format `shasum -a 256 -c` reads) and checks it.
7. Unpacks the zip twice, with `ditto -x -k` (what Finder does) and with `unzip`, and repeats the bundle checks on
   each copy.
8. Fills in the cask from `packaging/homebrew/signalbox.rb.template` and, when `ruby` is present, checks its syntax.
9. Prints a summary: commit and tree state, tag, zip path and size, SHA-256, cask path, download URL, signing.

### The cask

`packaging/homebrew/signalbox.rb.template` installs `Signalbox.app`, links the bundled CLI as `signalbox` on the
PATH, needs macOS 14 (Sonoma) or later on Apple silicon, and carries a caveat about the first launch. `brew uninstall
--zap` also removes `~/Library/Application Support/signalbox` (the spool folder it shares with the signalbox-tap
plugin), `~/Library/Preferences/dev.signalbox.app.plist` and the saved window state.

Homebrew only reads casks that live in a tap (Homebrew 7.0.3 refuses a plain file path), and the scripts don't create
one. To try a cask locally, by hand (this changes your Homebrew; it has not been run as part of these scripts):

```sh
apps/macos/scripts/release.sh --url-base "file://$PWD/dist/release"
brew tap-new --no-git "$USER/local"
cp dist/release/signalbox.rb "$(brew --repository)/Library/Taps/$USER/homebrew-local/Casks/"
brew audit --cask --strict "$USER/local/signalbox"
brew install --cask "$USER/local/signalbox"
# afterwards: brew uninstall --cask signalbox && brew untap "$USER/local"
```

Homebrew's main cask repository is phasing out apps that fail Gatekeeper checks, so until Signalbox is notarized it
belongs in its own tap. A CLI-only formula (as `docs/BRAINSTORM.md` §8 suggests) would avoid Gatekeeper for terminal
users; the cask already links the same CLI.

## First launch on another Mac

An ad-hoc signature is enough to run on Apple silicon, but Gatekeeper doesn't trust it. Browsers and Homebrew mark
downloads with the quarantine flag, so the first launch is blocked:

- macOS 15 and later: try to open Signalbox, then click **Open Anyway** in System Settings ▸ Privacy & Security.
- macOS 14: Control-click the app in Finder and choose **Open**.
- Or remove the flag from that one copy: `xattr -d com.apple.quarantine /Applications/Signalbox.app`.

The Mac that built the app doesn't see this, because a local build isn't quarantined.

## Notarization (not done)

> **Not set up.** Nothing below exists in the repo yet. Each step needs your Apple account, so an agent must not run
> them: they use credentials from your keychain, which Signalbox's rules keep agents away from.

What notarizing would take:

1. **Apple Developer Program** membership (paid, yearly). It gives you a Team ID.
2. A **Developer ID Application** certificate, created in your developer account (or Xcode ▸ Settings ▸ Accounts) and
   installed in the build Mac's login keychain.
3. **Signing with the hardened runtime and a secure timestamp**, inside out, in place of the ad-hoc signing in
   `build-app.sh`:
   ```sh
   id="Developer ID Application: Your Name (TEAMID)"
   codesign --force --options runtime --timestamp --entitlements packaging/cli.entitlements \
     --sign "$id" Signalbox.app/Contents/Resources/signalbox
   codesign --force --options runtime --timestamp --sign "$id" Signalbox.app
   ```
   The CLI is a Bun-compiled binary with JavaScriptCore inside, which compiles JavaScript at run time. Under the
   hardened runtime that needs entitlements, at least `com.apple.security.cs.allow-jit`; Bun's code-signing guide
   lists the set it recommends. `packaging/cli.entitlements` doesn't exist yet: write it from that guide and test the
   signed CLI before relying on it.
4. **Credentials for `notarytool`**: an app-specific password for your Apple ID, or an App Store Connect API key.
   Store them once with `xcrun notarytool store-credentials signalbox-notary --apple-id you@example.com --team-id
   TEAMID`, which keeps them in your keychain.
5. **Submit** the zip and wait for the verdict:
   `xcrun notarytool submit Signalbox-0.2.0-macos-arm64.zip --keychain-profile signalbox-notary --wait`. If it is
   rejected, `xcrun notarytool log <submission id> --keychain-profile signalbox-notary` says why.
6. **Staple** the ticket to the app (`xcrun stapler staple Signalbox.app`; a zip can't hold a ticket), then zip the
   stapled app again and recompute the SHA-256, because the published zip must contain the stapled app.
7. **Check**: `xcrun stapler validate Signalbox.app`, and `spctl --assess --type execute -vv Signalbox.app` should
   report a notarized Developer ID source.
8. Then remove the first-launch caveat from the cask template and the "not notarized" notes from this file and
   `apps/macos/README.md`.

`release.sh` would gain a `--sign IDENTITY` option and a notarize step that runs only when you pass a keychain
profile. Until then, it says "ad-hoc, not notarized" in its summary.
