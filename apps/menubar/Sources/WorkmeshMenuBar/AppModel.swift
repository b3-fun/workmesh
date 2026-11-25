import AppKit
import SwiftUI

/// Owns the poll loops and exposes the current daemon view to SwiftUI.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var state: DaemonState?
    @Published private(set) var config: DaemonConfig?
    @Published private(set) var reachable = false
    /// GET /team. nil before the first read and for a daemon without the
    /// endpoint; `teamChecked` tells the two apart.
    @Published private(set) var team: TeamState?
    @Published private(set) var teamChecked = false
    /// Teammates whose sessions are expanded, by name. Memory only.
    @Published var expandedPeople = Set<String>()
    /// Notify when an agent newly needs you. App-local preference: on unless
    /// the user turned it off.
    @Published var notifyOnNeedsYou: Bool {
        didSet {
            UserDefaults.standard.set(notifyOnNeedsYou, forKey: Self.notifyKey)
            if notifyOnNeedsYou { notifier?.requestPermission() }
            updateNotifier()
        }
    }

    /// Set by the menu window: the team view is read every 5 s while it shows
    /// (and the daemon reads the hub faster), every 15 s otherwise.
    var menuOpen = false {
        didSet {
            guard menuOpen != oldValue else { return }
            scheduleTeamPoll()
            if menuOpen { Task { await refreshTeam() } }
        }
    }

    private static let notifyKey = "notifyOnNeedsYou"
    private let client = DaemonClient()
    /// nil in snapshot mode: no permission prompt, nothing posted.
    private let notifier: Notifier?
    private var timer: Timer?
    private var teamTimer: Timer?
    private var teamInFlight = false
    private let pollInterval: TimeInterval = 2
    private var teamInterval: TimeInterval { menuOpen ? 5 : 15 }

    var blip: BlipState { BlipState.from(state: reachable ? state : nil) }

    init(snapshot: Bool = false) {
        let defaults = UserDefaults.standard
        notifyOnNeedsYou = defaults.object(forKey: Self.notifyKey) == nil ? true : defaults.bool(forKey: Self.notifyKey)
        notifier = snapshot ? nil : Notifier()
        if notifyOnNeedsYou { notifier?.requestPermission() }
        start() // begin polling at launch so the icon is live before first click
    }

    func start() {
        Task { await self.refresh() }
        let t = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        scheduleTeamPoll()
    }

    private func scheduleTeamPoll() {
        teamTimer?.invalidate()
        let t = Timer(timeInterval: teamInterval, repeats: true) { [weak self] _ in
            Task { await self?.refreshTeam() }
        }
        RunLoop.main.add(t, forMode: .common)
        teamTimer = t
    }

    func refresh() async {
        do {
            let s = try await client.fetchState()
            let c = try? await client.fetchConfig()
            let wasReachable = reachable
            state = s
            if let c { config = c }
            reachable = true
            updateNotifier()
            // Daemon came (back) up: don't wait up to 15 s for the team.
            if !wasReachable || !teamChecked { Task { await refreshTeam() } }
        } catch {
            reachable = false
        }
    }

    /// Cheap loopback read: the daemon polls the hub and caches the answer.
    func refreshTeam() async {
        guard !teamInFlight else { return }
        teamInFlight = true
        defer { teamInFlight = false }
        do {
            team = try await client.fetchTeam(open: menuOpen)
            teamChecked = true
            updateNotifier()
        } catch {
            // Daemon down or a bad answer: keep the last view; /state drives "offline".
        }
    }

    private func updateNotifier() {
        guard let notifier, let s = state else { return }
        notifier.update(
            needs: NeedItem.merge(local: s.snapshot.sessions, team: team?.team, deviceId: team?.deviceId),
            teamReady: team?.team != nil,
            enabled: notifyOnNeedsYou
        )
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

    // MARK: Local actions (no daemon round trip)

    func togglePerson(_ name: String) {
        if expandedPeople.contains(name) {
            expandedPeople.remove(name)
        } else {
            expandedPeople.insert(name)
        }
    }

    func openBoard() {
        guard let url = team?.boardLink else { return }
        NSWorkspace.shared.open(url)
    }

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
