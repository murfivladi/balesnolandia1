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
            displayVersion: "0.3.0",
            bundleVersion: "3",
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
            capabilities: [
                .faceID(purposeString: "ВлодБраузер подтверждает Face ID вход во ВлодБанк, переводы и подстановку паролей и PIN карт."),
                .camera(purposeString: "Камера нужна, чтобы сканировать QR-коды: перенос закладок, оплата и проверка документов."),
                .photoLibraryAdd(purposeString: "ВлодБраузер сохраняет скачанные чеки и документы в «Фото» по вашей просьбе.")
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
