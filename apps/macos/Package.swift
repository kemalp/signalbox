// swift-tools-version: 6.0
// Signalbox for macOS: a native SwiftUI front end that drives the bundled `signalbox` CLI over NDJSON.
import PackageDescription

let package = Package(
    name: "Signalbox",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Signalbox", targets: ["Signalbox"]),
        .library(name: "SignalboxKit", targets: ["SignalboxKit"]),
    ],
    targets: [
        .target(name: "SignalboxKit"),
        // signalbox-switch (docs/SWITCH.md): the only code that writes outside Signalbox's own settings and labels.
        // Only the app links it; SignalboxKit never imports it.
        .target(name: "SignalboxSwitch", dependencies: ["SignalboxKit"]),
        .executableTarget(name: "Signalbox", dependencies: ["SignalboxKit", "SignalboxSwitch"]),
        .testTarget(
            name: "SignalboxKitTests",
            dependencies: ["SignalboxKit"],
            exclude: ["Fixtures"]
        ),
        .testTarget(name: "SignalboxSwitchTests", dependencies: ["SignalboxSwitch", "SignalboxKit"]),
    ]
)
