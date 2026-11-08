// swift-tools-version: 5.8

// ВлодБраузер для iOS — приложение Swift Playgrounds (iPad) и Xcode.
// Открыть на iPad: «Файлы» → VlodBrowser.swiftpm → Swift Playgrounds → ▶︎.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "VlodBrowser",
    platforms: [
        .iOS("16.0")
    ],
    products: [
        .iOSApplication(
            name: "ВлодБраузер",
            targets: ["AppModule"],
            bundleIdentifier: "io.qzz.vladislavb.vlodbrowser",
            teamIdentifier: "",
            displayVersion: "0.2.0",
            bundleVersion: "2",
            appIcon: .asset("AppIcon"),
            accentColor: .presetColor(.blue),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ],
            appCategory: .utilities
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
