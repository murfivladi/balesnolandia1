import SwiftUI
import VisionKit
import AVFoundation

/// Сканер QR камерой (VisionKit, iOS 16+). Для импорта закладок; в И3 — оплата и проверка документов.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    @MainActor static var isAvailable: Bool {
        DataScannerViewController.isSupported
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {
        if !vc.isScanning && DataScannerViewController.isAvailable { try? vc.startScanning() }
    }

    static func dismantleUIViewController(_ vc: DataScannerViewController, coordinator: Coordinator) {
        vc.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in addedItems {
                if case .barcode(let b) = item, let s = b.payloadStringValue {
                    done = true
                    onCode(s)
                    return
                }
            }
        }
    }
}

/// Лист со сканером и подсказкой.
struct QRScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var available = false
    @State private var asked = false

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                if available {
                    QRScannerView(onCode: onCode).ignoresSafeArea()
                } else if !asked {
                    ProgressView()
                } else {
                    Text("Камера недоступна: разрешите ВлодБраузеру доступ к камере в «Настройках».")
                        .multilineTextAlignment(.center)
                        .padding()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                Text("Наведите камеру на QR-код")
                    .font(.footnote)
                    .padding(10)
                    .background(Capsule().fill(.regularMaterial))
                    .padding(.bottom, 30)
            }
            .navigationTitle("Сканер QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } } }
        }
        .task {
            // Первый раз система спрашивает разрешение на камеру.
            _ = await AVCaptureDevice.requestAccess(for: .video)
            available = DataScannerViewController.isAvailable
            asked = true
        }
    }
}
