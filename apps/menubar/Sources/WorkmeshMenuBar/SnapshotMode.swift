import AppKit
import SwiftUI

/// Development snapshot mode: `WORKMESH_SNAPSHOT=<out.png>` renders the menu to
/// a PNG and exits, so the UI can be checked against `scripts/mock-daemon.mjs`
/// without clicking the menu bar.
///
/// - `WORKMESH_SNAPSHOT_EXPAND=<name>[,<name>]` expands those teammates.
/// - `WORKMESH_SNAPSHOT_APPEARANCE=dark|light` (default light).
/// - `WORKMESH_SNAPSHOT_SHEET=update-running|update-finished|update-failed|
///   update-cant|update-app-failed` draws the "Updating Workmesh" window in that
///   state, with fixture output, instead of the menu (no daemon needed).
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

    /// Drawing the update window: nothing reads the daemon.
    static var drawsSheet: Bool { isEnabled && !(env["WORKMESH_SNAPSHOT_SHEET"] ?? "").isEmpty }

    private static var window: NSWindow?

    static func run(model: AppModel) {
        guard let out = outputPath else { return }
        if let sheet = env["WORKMESH_SNAPSHOT_SHEET"], !sheet.isEmpty {
            return runSheet(sheet, to: out)
        }
        Task { @MainActor in
            let deadline = Date().addingTimeInterval(15)
            while model.state == nil || !model.teamChecked || !model.updateChecked {
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

    // MARK: The update window

    private static func runSheet(_ sheet: String, to out: String) {
        let runner = UpdateRunner()
        guard seed(runner, sheet) else { fail("unknown WORKMESH_SNAPSHOT_SHEET \(sheet)") }
        let dark = env["WORKMESH_SNAPSHOT_APPEARANCE"]?.lowercased() == "dark"
        Task { @MainActor in
            let panel = UpdateWindow.makePanel(runner: runner) {}
            panel.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            panel.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
            panel.orderFrontRegardless()
            window = panel
            try? await Task.sleep(nanoseconds: 800_000_000)
            // The frame view: title bar and content, as the window shows.
            guard let frame = panel.contentView?.superview else { fail("no window frame to draw") }
            frame.layoutSubtreeIfNeeded()
            frame.display()
            write(frame, to: out)
        }
    }

    private static let release = UpdateInfo.MenubarRelease(
        version: "0.12.1",
        url: URL(string: "https://github.com/b3-fun/workmesh/releases/download/v0.12.1/Workmesh-menubar-macos.zip")!,
        sha256: "bf0e42a508d0d5a0a4841c60994e843df3a5286203f32a9d9c6ea5bde68f948c",
        size: 431_597,
        releaseUrl: "https://github.com/b3-fun/workmesh/releases/tag/v0.12.1"
    )

    private static let runningLog = """
    Workmesh 0.12.0 → 0.12.1 (npm, /opt/homebrew/lib/node_modules/@b3os/workmesh)
    Installing @b3os/workmesh@0.12.1 with npm…

    changed 41 packages in 14s
    Checking the new version: workmesh 0.12.1
    Re-running setup: Claude Code and Codex hooks are current

    """

    private static let finishedLog = runningLog + """
    Restarting the daemon…
      stopped the daemon (pid 48211)
      started the daemon (pid 48390) on 127.0.0.1:4519
    Updated Workmesh 0.12.0 → 0.12.1.

    """

    private static let failedLog = """
    Workmesh 0.12.0 → 0.12.1 (npm, /usr/local/lib/node_modules/@b3os/workmesh)
    Installing @b3os/workmesh@0.12.1 with npm…
    npm error code EACCES
    npm error syscall rename
    npm error path /usr/local/lib/node_modules/@b3os/workmesh
    npm error errno -13
    npm error Error: EACCES: permission denied, rename '/usr/local/lib/node_modules/@b3os/workmesh'
    Install failed: npm exited 243.
    Rolled back: Workmesh 0.12.0 is installed and the daemon is running it again.

    """

    private static let cantLog = """
    Workmesh 0.12.0 runs from a git checkout at ~/src/workmesh.
    Pull and build it there (git pull && npm run build -w @b3os/workmesh), then run `workmesh update`.

    """

    private static let appFailedLog = """
    Downloading https://github.com/b3-fun/workmesh/releases/download/v0.12.1/Workmesh-menubar-macos.zip
    Downloaded 432 KB
    The download's SHA-256 (5c1d09e7a2f4…) doesn't match the release's (bf0e42a508d0…), so it was thrown away. Workmesh.app is unchanged.

    """

    private static func seed(_ r: UpdateRunner, _ sheet: String) -> Bool {
        switch sheet {
        case "update", "update-running":
            r.seed(phase: .running, log: runningLog, from: "0.12.0", target: "0.12.1")
        case "update-finished":
            r.seed(phase: .finished, log: finishedLog, from: "0.12.0", target: "0.12.1", nowOn: "0.12.1",
                   appOffer: UpdateRunner.newerApp(release))
        case "update-failed":
            r.seed(phase: .failed(1), log: failedLog, from: "0.12.0", target: "0.12.1")
        case "update-cant":
            r.seed(phase: .cantUpdate, log: cantLog, from: "0.12.0", target: "0.12.1")
        case "update-app-failed":
            let message = "The download's SHA-256 (5c1d09e7a2f4…) doesn't match the release's (bf0e42a508d0…), so it was thrown away. Workmesh.app is unchanged."
            r.seed(phase: .appFailed(message), log: appFailedLog, from: nil, target: nil, appTarget: "0.12.1")
        default:
            return false
        }
        return true
    }

    // MARK: The menu

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

    /// A view drawn at 2x as PNG data, in the given appearance.
    static func png(of view: NSView, appearance: NSAppearance?) -> Data? {
        let bounds = view.bounds
        let scale: CGFloat = 2
        guard bounds.width > 0, bounds.height > 0,
              let rep = NSBitmapImageRep(
                  bitmapDataPlanes: nil,
                  pixelsWide: Int(bounds.width * scale), pixelsHigh: Int(bounds.height * scale),
                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
              )
        else { return nil }
        rep.size = bounds.size
        let draw = { view.cacheDisplay(in: bounds, to: rep) }
        if let appearance {
            appearance.performAsCurrentDrawingAppearance(draw)
        } else {
            draw()
        }
        return rep.representation(using: .png, properties: [:])
    }

    private static func write(_ view: NSView, to path: String) {
        let bounds = view.bounds
        guard let png = png(of: view, appearance: window?.appearance) else { fail("nothing to draw") }
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
