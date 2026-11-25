import AppKit
import Combine
import SwiftUI

/// The "Updating Workmesh" window. The menu's own window closes when it loses
/// focus, so the update runs in a panel of its own that stays up until Done.
@MainActor
final class UpdateWindow {
    static let shared = UpdateWindow()
    private var panel: NSPanel?
    private var captures: AnyCancellable?

    func show(runner: UpdateRunner) {
        let p = panel ?? make(runner: runner)
        if panel == nil { captureLive(p, runner: runner) }
        panel = p
        if !p.isVisible { p.center() }
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
    }

    func close() {
        panel?.orderOut(nil)
    }

    /// A titled panel hosting the SwiftUI view; snapshot mode draws one off screen.
    static func makePanel(runner: UpdateRunner, done: @escaping () -> Void) -> NSPanel {
        let hosting = NSHostingController(rootView: UpdateView(runner: runner, done: done))
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: UpdateView.width, height: UpdateView.height),
                        styleMask: [.titled, .closable], backing: .buffered, defer: false)
        p.title = "Updating Workmesh"
        p.contentViewController = hosting
        p.setContentSize(NSSize(width: UpdateView.width, height: UpdateView.height))
        // A menu bar app is often not the active app: keep the panel up anyway.
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.becomesKeyOnlyIfNeeded = false
        return p
    }

    private func make(runner: UpdateRunner) -> NSPanel {
        Self.makePanel(runner: runner) { [weak self] in self?.close() }
    }

    /// WORKMESH_DEV_CAPTURE=<dir>: the live window drawn to a PNG at each step
    /// (development evidence without screen recording permission).
    private func captureLive(_ p: NSPanel, runner: UpdateRunner) {
        guard let dir = ProcessInfo.processInfo.environment["WORKMESH_DEV_CAPTURE"], !dir.isEmpty else { return }
        var n = 0
        captures = runner.$phase.combineLatest(runner.$waitingForDaemon, runner.$appOffer.map { $0?.version })
            .debounce(for: .milliseconds(700), scheduler: RunLoop.main)
            .sink { [weak p] phase, _, _ in
                guard let frame = p?.contentView?.superview,
                      let png = SnapshotMode.png(of: frame, appearance: p?.effectiveAppearance)
                else { return }
                n += 1
                let name = String(describing: phase).replacingOccurrences(of: "\"", with: "").prefix(40)
                try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(String(format: "live-%02d-", n) + name + ".png"))
            }
    }
}

struct UpdateView: View {
    @ObservedObject var runner: UpdateRunner
    let done: () -> Void

    static let width: CGFloat = 560
    static let height: CGFloat = 400

    /// What the window says about the downloaded app and Gatekeeper.
    static let gatekeeperNote = "Downloaded from the GitHub release and checked against its SHA-256. Workmesh clears the quarantine flag itself, so the new version opens without a Gatekeeper prompt."

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            output
            if let offer = shownOffer {
                appOffer(offer)
            }
            HStack {
                Spacer()
                Button("Done", action: done)
                    .keyboardShortcut(.defaultAction)
                    .disabled(runner.isBusy)
            }
        }
        .padding(16)
        .frame(width: Self.width, height: Self.height)
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            glyph
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(headline)
                    .font(.system(size: 13, weight: .semibold))
                Text(subline)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var glyph: some View {
        switch runner.phase {
        case .running, .appUpdating, .relaunching:
            ProgressView().controlSize(.small)
        case .finished:
            if runner.waitingForDaemon {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(.green)
            }
        case .failed, .appFailed:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 18))
                .foregroundStyle(.red)
        case .cantUpdate, .idle:
            Image(systemName: "info.circle")
                .font(.system(size: 18))
                .foregroundStyle(.secondary)
        }
    }

    private var headline: String {
        switch runner.phase {
        case .idle: return "Workmesh"
        case .running: return runner.target.map { "Updating Workmesh to \($0)" } ?? "Updating Workmesh"
        case .finished: return runner.nowOn.map { "Workmesh \($0) is installed" } ?? "Workmesh is up to date"
        case .failed: return "The update didn't finish"
        case .cantUpdate: return "Workmesh can't update this install"
        case .appUpdating: return "Updating the menu bar app to \(runner.appTarget ?? "the new version")"
        case .appFailed: return "The menu bar app wasn't replaced"
        case .relaunching: return "Relaunching Workmesh"
        }
    }

    private var subline: String {
        switch runner.phase {
        case .idle: return ""
        case .running: return "Installing it, then restarting the daemon. This takes up to a minute or two."
        case .finished:
            if runner.waitingForDaemon { return "Waiting for the daemon to come back…" }
            return runner.nowOn != nil ? "The daemon is running the new version." : "The daemon hasn't answered since; the menu shows it once it's back."
        case .failed(let code):
            return code < 0 ? "It didn't run to the end. The output says how far it got."
                : "It exited \(code). The output says what went wrong and whether it rolled back."
        case .cantUpdate: return "The output says what to do instead."
        case .appUpdating: return "Downloading it and checking it against the release's SHA-256."
        case .appFailed: return "The current app keeps running. The output says why."
        case .relaunching: return "The new menu bar app opens in a moment."
        }
    }

    // MARK: Output

    private var output: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(runner.log.isEmpty ? "Starting…" : runner.log)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(runner.log.isEmpty ? .secondary : .primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(10)
            }
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
            )
            .onChange(of: runner.log) { _ in proxy.scrollTo(Self.bottom, anchor: .bottom) }
            .onAppear { proxy.scrollTo(Self.bottom, anchor: .bottom) }
        }
    }

    private static let bottom = "bottom"

    // MARK: The menu bar app

    /// After a good run, when the release's menu bar app is newer than this one.
    private var shownOffer: UpdateInfo.MenubarRelease? {
        guard runner.phase == .finished, !runner.waitingForDaemon else { return nil }
        return runner.appOffer
    }

    @ViewBuilder
    private func appOffer(_ offer: UpdateInfo.MenubarRelease) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let problem = AppSelfUpdate.locationProblem() {
                Text("The menu bar app \(offer.version) is out, but this one can't replace itself here.")
                    .font(.system(size: 12, weight: .medium))
                Text(problem)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Button("Relaunch with the new menu bar app \(offer.version)") {
                    runner.updateApp(offer)
                }
                .controlSize(.regular)
                Text(Self.gatekeeperNote)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
