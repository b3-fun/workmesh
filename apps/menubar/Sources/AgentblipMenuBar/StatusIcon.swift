import AppKit

/// The menu bar glyph, built from SF Symbols so it sits with the system icons.
///
/// - Calm states are template images (macOS tints them for light/dark bars):
///   a ring when nothing runs, a filled dot (or numbered dot) while agents work.
///   Filled = syncing to Slack ("on air"); outlined = sync is off (paused,
///   snoozed, or standing down for your own status).
/// - "Needs you" is the only coloured state: an orange dot, numbered when more
///   than one session is waiting, so it reads at a glance without flashing.
enum StatusIcon {
    private static let config = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)

    static func image(for blip: BlipState) -> NSImage {
        switch blip {
        case .unreachable:
            return template("circle.dashed", alpha: 0.45, label: "agentblip: daemon offline")
        case .idle:
            return template("circle", label: "agentblip: no agents running")
        case .working(let n, let onAir):
            let base = numbered(n)
            return template(onAir ? "\(base).fill" : base, label: "agentblip: \(n) working")
        case .needsYou(let n):
            return tinted("\(numbered(n)).fill", color: .systemOrange, label: "agentblip: \(n) need you")
        }
    }

    /// "circle" for one, "3.circle" for 2…50 (SF Symbols ships numbered circles to 50).
    private static func numbered(_ n: Int) -> String {
        (2...50).contains(n) ? "\(n).circle" : "circle"
    }

    private static func symbol(_ name: String, label: String) -> NSImage {
        let img = NSImage(systemSymbolName: name, accessibilityDescription: label)
            ?? NSImage(systemSymbolName: "circle", accessibilityDescription: label)!
        return img.withSymbolConfiguration(config) ?? img
    }

    private static func template(_ name: String, alpha: CGFloat = 1, label: String) -> NSImage {
        let base = symbol(name, label: label)
        guard alpha < 1 else {
            base.isTemplate = true
            return base
        }
        let faded = NSImage(size: base.size, flipped: false) { rect in
            base.draw(in: rect, from: .zero, operation: .sourceOver, fraction: alpha)
            return true
        }
        faded.isTemplate = true
        faded.accessibilityDescription = label
        return faded
    }

    /// Colours the symbol's shape; knocked-out parts (the number) stay clear,
    /// so the menu bar shows through like it does for template icons.
    private static func tinted(_ name: String, color: NSColor, label: String) -> NSImage {
        let base = symbol(name, label: label)
        let img = NSImage(size: base.size, flipped: false) { rect in
            base.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        img.isTemplate = false
        img.accessibilityDescription = label
        return img
    }
}
