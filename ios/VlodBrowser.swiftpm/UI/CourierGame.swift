import SwiftUI

/// «Курьер БалНета» — мини-игра для страницы «Нет связи» и обслуживания (порт web/src/browser/game.jsx).
/// Курьер ловит влодики и пакеты данных и уворачивается от битых пакетов «404». Палец — движение.
final class CourierState {
    struct Item { var x: CGFloat; var y: CGFloat; var kind: Int; var v: CGFloat }   // kind: 0 влодик, 1 пакет, 2 «404»

    static let w: CGFloat = 360
    static let h: CGFloat = 220

    var x: CGFloat = w / 2
    var items: [Item] = []
    var score = 0
    var lives = 3
    var spawn: CGFloat = 0
    var hit: CGFloat = 0
    var target: CGFloat?
    var last: Date?
    var playing = false

    func reset() {
        x = Self.w / 2; items = []; score = 0; lives = 3; spawn = 0; hit = 0; last = nil; playing = true
    }

    /// Шаг игры. Возвращает true, когда жизни кончились.
    func step(_ now: Date) -> Bool {
        guard playing else { return false }
        let dt = CGFloat(min(0.048, now.timeIntervalSince(last ?? now)) / 0.01667)
        last = now
        if let t = target { x += max(-7 * dt, min(7 * dt, t - x)) }
        x = max(18, min(Self.w - 18, x))
        let speed = 1.4 + CGFloat(score) / 400
        spawn -= dt
        if spawn <= 0 {
            let r = CGFloat.random(in: 0..<1)
            let kind = r < 0.22 + min(0.2, CGFloat(score) / 2000) ? 2 : (r < 0.85 ? 0 : 1)
            items.append(Item(x: 14 + .random(in: 0..<(Self.w - 28)), y: -12, kind: kind, v: speed * (0.8 + .random(in: 0..<0.6))))
            spawn = max(14, 40 - CGFloat(score) / 25)
        }
        for i in items.indices { items[i].y += items[i].v * dt }
        var keep: [Item] = []
        for it in items {
            if it.y > Self.h - 40 && it.y < Self.h - 14 && abs(it.x - x) < 24 {
                if it.kind == 0 { score += 10 } else if it.kind == 1 { score += 25 } else { lives -= 1; hit = 20 }
            } else if it.y < Self.h + 20 {
                keep.append(it)
            }
        }
        items = keep
        if hit > 0 { hit -= dt }
        if lives <= 0 { playing = false; return true }
        return false
    }
}

struct CourierGameView: View {
    @State private var game = CourierState()
    @State private var phase = 0   // 0 — готов, 1 — игра, 2 — конец
    @State private var lastScore = 0
    @AppStorage("courierBest") private var best = 0
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            TimelineView(.animation(paused: phase != 1)) { tl in
                Canvas { ctx, size in
                    if game.step(tl.date) {
                        let s = game.score
                        DispatchQueue.main.async { lastScore = s; best = max(best, s); phase = 2 }
                    }
                    draw(&ctx, size)
                }
            }
            .aspectRatio(CourierState.w / CourierState.h, contentMode: .fit)
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in game.target = v.location.x * CourierState.w / max(1, widthHint) }
                .onEnded { _ in game.target = nil })
            .background(GeometryReader { g in Color.clear.onAppear { widthHint = g.size.width }.onChange(of: g.size.width) { widthHint = $0 } })
            .clipShape(RoundedRectangle(cornerRadius: 12))

            if phase != 1 {
                VStack(spacing: 8) {
                    if phase == 2 { Text("Доставка сорвана! Очки: \(lastScore)").bold() }
                    Text("Ловите **влодики** и **пакеты**, избегайте **404**.").font(.footnote).multilineTextAlignment(.center)
                    Button(phase == 2 ? "Ещё раз" : "Играть") { game.reset(); phase = 1 }
                        .buttonStyle(.borderedProminent)
                    Text("Рекорд: \(best)").font(.caption).foregroundStyle(.secondary)
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 12).fill(.regularMaterial))
            }
        }
        .frame(maxWidth: 420)
        .accessibilityLabel("Игра «Курьер БалНета»")
    }

    @State private var widthHint: CGFloat = CourierState.w

    private func draw(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let k = size.width / CourierState.w
        let dark = scheme == .dark
        ctx.scaleBy(x: k, y: k)
        let w = CourierState.w, h = CourierState.h
        ctx.fill(Path(CGRect(x: 0, y: 0, width: w, height: h)), with: .color(dark ? Color(red: 0.09, green: 0.11, blue: 0.14) : Color(red: 0.96, green: 0.96, blue: 0.98)))
        ctx.fill(Path(CGRect(x: 0, y: h - 12, width: w, height: 12)), with: .color(dark ? Color(red: 0.17, green: 0.2, blue: 0.26) : Color(red: 0.87, green: 0.89, blue: 0.92)))
        for it in game.items {
            switch it.kind {
            case 0:
                ctx.fill(Path(ellipseIn: CGRect(x: it.x - 9, y: it.y - 9, width: 18, height: 18)), with: .color(Theme.gold))
                ctx.draw(Text("В").font(.system(size: 11, weight: .bold)).foregroundColor(Color(red: 0.36, green: 0.27, blue: 0.03)), at: CGPoint(x: it.x, y: it.y))
            case 1:
                ctx.fill(Path(CGRect(x: it.x - 10, y: it.y - 8, width: 20, height: 16)), with: .color(Theme.accent))
                ctx.draw(Text("✉").font(.system(size: 11)).foregroundColor(.white), at: CGPoint(x: it.x, y: it.y))
            default:
                ctx.fill(Path(CGRect(x: it.x - 13, y: it.y - 8, width: 26, height: 16)), with: .color(Theme.danger))
                ctx.draw(Text("404").font(.system(size: 9, weight: .bold)).foregroundColor(.white), at: CGPoint(x: it.x, y: it.y))
            }
        }
        let blink = game.hit > 0 && Int(game.hit / 3) % 2 == 0
        if !blink {
            ctx.fill(Path(CGRect(x: game.x - 20, y: h - 34, width: 40, height: 14)), with: .color(Theme.gov))
            ctx.fill(Path(ellipseIn: CGRect(x: game.x - 17, y: h - 20, width: 8, height: 8)), with: .color(dark ? .white : .black))
            ctx.fill(Path(ellipseIn: CGRect(x: game.x + 9, y: h - 20, width: 8, height: 8)), with: .color(dark ? .white : .black))
            ctx.fill(Path(CGRect(x: game.x - 3, y: h - 46, width: 6, height: 12)), with: .color(Theme.gold))
        }
        ctx.draw(Text("Очки: \(game.score)").font(.system(size: 12, weight: .bold)).foregroundColor(dark ? .white : .black), at: CGPoint(x: 8, y: 12), anchor: .leading)
        ctx.draw(Text(String(repeating: "♥", count: max(0, game.lives))).font(.system(size: 12, weight: .bold)).foregroundColor(Theme.danger), at: CGPoint(x: w - 8, y: 12), anchor: .trailing)
    }
}
