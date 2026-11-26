import Foundation
import UserNotifications

/// Posts a macOS notification when an agent newly needs you: a local waiting
/// session, or a needsMe item the hub lists from another of your machines. On
/// unless you turn it off in Settings.
///
/// One notification per waiting episode (session plus when the wait began),
/// counted once across both sources: the local row and the hub's item for the
/// same session are one wait, and a wait seen first on one side and then only
/// on the other (dismissed here, still listed by the hub) isn't a new one.
/// Waits already present when the app starts don't fire; each source is primed
/// by its first read.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private struct Seen {
        var since: Double
        var local: Bool
        var lastSeen: Date
    }

    /// By NeedItem.key. Kept a while after a wait drops out of view, so a row
    /// that flickers out of one read and back doesn't notify twice.
    private var seen: [String: Seen] = [:]
    private var primedLocal = false
    private var primedTeam = false
    private let forgetAfter: TimeInterval = 120

    /// UNUserNotificationCenter traps outside an app bundle (e.g. `swift run`).
    private var center: UNUserNotificationCenter? {
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    override init() {
        super.init()
        center?.delegate = self
    }

    func requestPermission() {
        center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Called with every fresh /state or /team read. `teamReady` once the
    /// daemon has a team view (so its needsMe items count as "already there").
    func update(needs: [NeedItem], teamReady: Bool, enabled: Bool) {
        let now = Date()
        for n in needs {
            var fresh = true
            if let prev = seen[n.key] {
                // Same side, later start: a new wait. Other side: the same wait.
                fresh = prev.local == n.isLocal && n.since > prev.since + 1000
            }
            let primed = n.isLocal ? primedLocal : primedTeam
            if fresh && primed && enabled { post(n) }
            seen[n.key] = Seen(since: n.since, local: n.isLocal, lastSeen: now)
        }
        seen = seen.filter { now.timeIntervalSince($0.value.lastSeen) < forgetAfter }
        primedLocal = true
        if teamReady { primedTeam = true }
    }

    /// Called with every /team read: one notification per new machine on the
    /// person's account. It is about the account, not an agent, so the "needs
    /// me" switch doesn't turn it off. The ids already posted are kept across
    /// launches, so a restart of the app doesn't post them again.
    func newDevices(_ notices: [NewDeviceNotice]) {
        guard !notices.isEmpty else { return }
        let defaults = UserDefaults.standard
        var posted = defaults.stringArray(forKey: Self.postedDevicesKey) ?? []
        let fresh = notices.filter { !posted.contains($0.id) }
        guard !fresh.isEmpty else { return }
        for n in fresh {
            post(n)
            posted.append(n.id)
        }
        defaults.set(Array(posted.suffix(Self.postedDevicesMax)), forKey: Self.postedDevicesKey)
    }

    private static let postedDevicesKey = "newDevicesNotified"
    private static let postedDevicesMax = 200

    private func post(_ n: NewDeviceNotice) {
        guard let center else { return }
        let id = "new-device-\(n.id)"
        let body = "\(n.machine)\(n.place.map { ", from \($0)" } ?? ""). If this wasn't you, remove it on the board."
        // Ask first: with "needs me" notifications off, the app may never have asked.
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "A new machine joined your Workmesh account"
            content.body = body
            content.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        }
    }

    private func post(_ n: NeedItem) {
        let content = UNMutableNotificationContent()
        content.title = n.title
        let reason = n.reason ?? "Needs your input"
        if let name = n.name, name != n.title {
            content.body = "\(reason) · \(name)"
        } else {
            content.body = reason
        }
        content.sound = .default
        let id = "\(n.key)@\(Int(n.since))"
        center?.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    // A menu-bar agent counts as frontmost while its menu is open: show the
    // banner anyway.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
