import AppKit
import SwiftUI

/// Development snapshot mode: `WORKMESH_SNAPSHOT=<out.png>` renders the menu to
/// a PNG and exits, so the UI can be checked against `scripts/mock-daemon.mjs`
/// without clicking the menu bar.
///
/// - `WORKMESH_SNAPSHOT_EXPAND=<name>[,<name>]` expands those teammates.
/// - `WORKMESH_SNAPSHOT_APPEARANCE=dark|light` (default light).
///
/// After the first good /state and /team reads, MenuContent is hosted in an
/// NSHostingView in a borderless window placed off screen, given a moment for
/// avatars to load, and drawn with `cacheDisplay` at 2x. (ImageRenderer draws
/// AppKit-backed controls such as the gear menu as placeholders; a real view
/// hierarchy doesn't.) No menu bar item, no notifications.
@MainActor
enum SnapshotMode {
    private static var env: [String: String] { ProcessInfo.processInfo.environment }

    static var outputPath: String? {
        guard let p = env["WORKMESH_SNAPSHOT"], !p.isEmpty else { return nil }
        return p
    }

    static var isEnabled: Bool { outputPath != nil }

    private static var window: NSWindow?

    static func run(model: AppModel) {
        guard let out = outputPath else { return }
        Task { @MainActor in
            let deadline = Date().addingTimeInterval(15)
            while model.state == nil || !model.teamChecked {
                if Date() > deadline { fail("no /state and /team from the daemon within 15 s (is the mock running?)") }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            for name in (env["WORKMESH_SNAPSHOT_EXPAND"] ?? "").split(separator: ",") {
                model.expandedPeople.insert(name.trimmingCharacters(in: .whitespaces))
            }
            let dark = env["WORKMESH_SNAPSHOT_APPEARANCE"]?.lowercased() == "dark"
            let host = show(model: model, dark: dark)
            // Let onAppear's /team?open=1 read land and AsyncImage fetch avatars.
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            fit(host)
            try? await Task.sleep(nanoseconds: 300_000_000)
            fit(host)
            write(host, to: out)
        }
    }

    private static func show(model: AppModel, dark: Bool) -> NSView {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let hosting = NSHostingView(rootView: MenuContent(model: model))
        let size = hosting.fittingSize

        // The menu's window material, then the content over it.
        let background = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        background.material = .popover
        // Within-window: an offscreen window has nothing behind it to blend with,
        // and cacheDisplay then draws the material's own tone.
        background.blendingMode = .withinWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 10
        background.layer?.masksToBounds = true
        background.autoresizingMask = [.width, .height]

        let container = SnapshotContainer(frame: NSRect(origin: .zero, size: size))
        container.wantsLayer = true
        container.addSubview(background)
        hosting.frame = container.bounds
        hosting.autoresizingMask = [.width, .height]
        container.addSubview(hosting)
        container.hosting = hosting

        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
                         backing: .buffered, defer: false)
        w.appearance = appearance
        w.isOpaque = false
        w.backgroundColor = .clear
        w.isReleasedWhenClosed = false
        w.contentView = container
        w.setFrameOrigin(NSPoint(x: -20_000, y: -20_000)) // off every screen
        w.orderFrontRegardless()
        window = w
        return container
    }

    /// Resize the window to the content's current height (rows load in).
    private static func fit(_ container: NSView) {
        guard let w = window, let hosting = (container as? SnapshotContainer)?.hosting else { return }
        let size = hosting.fittingSize
        w.setContentSize(size)
        container.layoutSubtreeIfNeeded()
        container.display()
    }

    private static func write(_ view: NSView, to path: String) {
        let bounds = view.bounds
        let scale: CGFloat = 2
        guard bounds.width > 0, bounds.height > 0,
              let rep = NSBitmapImageRep(
                  bitmapDataPlanes: nil,
                  pixelsWide: Int(bounds.width * scale), pixelsHigh: Int(bounds.height * scale),
                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
              )
        else { fail("nothing to draw") }
        rep.size = bounds.size
        let draw = { view.cacheDisplay(in: bounds, to: rep) }
        if let appearance = window?.appearance {
            appearance.performAsCurrentDrawingAppearance(draw)
        } else {
            draw()
        }
        guard let png = rep.representation(using: .png, properties: [:]) else { fail("PNG encoding failed") }
        do {
            try png.write(to: URL(fileURLWithPath: path))
        } catch {
            fail("can't write \(path): \(error.localizedDescription)")
        }
        print("snapshot: wrote \(path) (\(Int(bounds.width))x\(Int(bounds.height)) pt @2x)")
        exit(0)
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("snapshot: \(message)\n".utf8))
        exit(1)
    }
}

/// Holds the material and the hosting view; remembers the hosting view for refits.
private final class SnapshotContainer: NSView {
    var hosting: NSView?
}
