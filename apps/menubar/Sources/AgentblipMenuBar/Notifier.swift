import Foundation
import UserNotifications

/// Posts a macOS notification when a session newly needs you. Off by default;
/// the menu's Settings toggle turns it on (and asks for permission then).
///
/// A "waiting episode" is a session key plus when its waiting state began, so
/// one wait notifies once, and the sessions already waiting when the app
/// launches don't all fire at once.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private var seen = Set<String>()
    private var primed = false

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

    func update(sessions: [AgentSession], enabled: Bool) {
        let waiting = sessions.filter { $0.state == "waiting" && $0.foldedInto == nil }
        var current = Set<String>()
        for s in waiting {
            let episode = "\(s.key)@\(Int(s.stateSince ?? s.updatedAt))"
            current.insert(episode)
            if enabled && primed && !seen.contains(episode) { post(s, id: episode) }
        }
        seen = current
        primed = true
    }

    private func post(_ s: AgentSession, id: String) {
        let content = UNMutableNotificationContent()
        content.title = s.project ?? s.name ?? "An agent"
        content.body = s.name.map { "Needs your input · \($0)" } ?? "Needs your input"
        content.sound = .default
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
