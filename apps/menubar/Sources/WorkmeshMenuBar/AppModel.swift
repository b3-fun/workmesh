import AppKit
import SwiftUI

/// Owns the poll loop and exposes the current daemon view to SwiftUI.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var state: DaemonState?
    @Published private(set) var config: DaemonConfig?
    @Published private(set) var reachable = false
    /// Notify when a session newly needs you. App-local preference, off by default.
    @Published var notifyOnNeedsYou: Bool {
        didSet {
            UserDefaults.standard.set(notifyOnNeedsYou, forKey: Self.notifyKey)
            if notifyOnNeedsYou { notifier.requestPermission() }
        }
    }

    private static let notifyKey = "notifyOnNeedsYou"
    private let client = DaemonClient()
    private let notifier = Notifier()
    private var timer: Timer?
    private let pollInterval: TimeInterval = 2

    var blip: BlipState { BlipState.from(state: reachable ? state : nil) }

    init() {
        notifyOnNeedsYou = UserDefaults.standard.bool(forKey: Self.notifyKey)
        start() // begin polling at launch so the icon is live before first click
    }

    func start() {
        Task { await self.refresh() }
        let t = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func refresh() async {
        do {
            let s = try await client.fetchState()
            let c = try? await client.fetchConfig()
            state = s
            if let c { config = c }
            reachable = true
            notifier.update(sessions: s.snapshot.sessions, enabled: notifyOnNeedsYou)
        } catch {
            reachable = false
        }
    }

    // Control actions: fire, then reconcile on a fresh poll so a failed call
    // self-corrects.
    func pause() { act { try await $0.pause() } }
    func resume() { act { try await $0.resume() } }
    func snooze(_ preset: SnoozePreset) { act { try await $0.snooze(preset) } }
    func dismiss(_ session: AgentSession) { act { try await $0.dismiss(key: session.key) } }

    private func act(_ call: @escaping (DaemonClient) async throws -> Data) {
        Task {
            _ = try? await call(client)
            await refresh()
        }
    }

    func setGranularity(_ value: String) { patch(["granularity": value]) }
    func setPolicy(_ value: String) { patch(["statusPolicy": value]) }
    func setRepoPrefix(_ value: Bool) { patch(["repoPrefix": value]) }

    private func patch(_ p: [String: Any]) {
        Task {
            if let c = try? await client.patchConfig(p) { config = c }
            await refresh()
        }
    }

    // MARK: Row actions (local, no daemon round trip)

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func revealInFinder(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func openConfigFile() {
        NSWorkspace.shared.open(URL(fileURLWithPath: Paths.configPath))
    }

    func quit() { NSApplication.shared.terminate(nil) }
}
