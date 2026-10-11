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
        .executableTarget(name: "Signalbox", dependencies: ["SignalboxKit"]),
        .testTarget(
            name: "SignalboxKitTests",
            dependencies: ["SignalboxKit"],
            exclude: ["Fixtures"]
        ),
    ]
)
