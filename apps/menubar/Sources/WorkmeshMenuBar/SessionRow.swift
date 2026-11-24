import AppKit
import SwiftUI

/// One action on a session row, shown both on click (a native pop-up menu)
/// and on right-click (SwiftUI context menu).
struct RowAction: Identifiable {
    let id = UUID()
    let title: String
    let systemImage: String
    /// Draw a separator above it.
    var separated = false
    let run: () -> Void
}

extension SessionGroup {
    var tint: Color {
        switch self {
        case .needsYou: return .orange
        case .working: return .green
        case .background: return .teal
        case .idle: return .secondary
        }
    }
}

/// A live session: project first, then what it's doing; source as a glyph,
/// fan-out as "+N", time in the current state on the right.
struct SessionRow: View {
    let session: AgentSession
    let group: SessionGroup
    let now: Date
    let actions: [RowAction]
    @State private var hovering = false

    var body: some View {
        Button {
            ActionMenu.popUp(actions)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: Self.glyph(for: session.source))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(group.tint)
                    .frame(width: 14, height: 16)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(title)
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let n = session.subagents, n > 0 {
                            Text("+\(n)")
                                .font(.system(size: 10, weight: .semibold))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.primary.opacity(0.08)))
                                .help("\(n) more agent\(n == 1 ? "" : "s") under this session")
                        }
                        Spacer(minLength: 8)
                        Text(Self.elapsed(since: session.stateSince ?? session.updatedAt, now: now))
                            .font(.system(size: 11))
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                    HStack(spacing: 4) {
                        Text(activity)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .layoutPriority(1)
                        if let name = session.name, name != title {
                            Text("· \(name)")
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    .font(.system(size: 11))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.primary.opacity(hovering ? 0.08 : 0))
            )
        }
        .buttonStyle(.plain)
        .opacity(group == .idle ? 0.75 : 1)
        .onHover { hovering = $0 }
        .help(tooltip)
        .contextMenu {
            ForEach(actions) { a in
                if a.separated { Divider() }
                Button {
                    a.run()
                } label: {
                    Label(a.title, systemImage: a.systemImage)
                }
            }
        }
    }

    private var title: String {
        session.project ?? session.name ?? String(session.sessionId.prefix(8))
    }

    private var activity: String {
        var text = session.activity ?? {
            switch group {
            case .needsYou: return "needs input"
            case .idle: return "idle"
            default: return "working"
            }
        }()
        if let phase = session.phase, !phase.isEmpty { text += " · \(phase)" }
        return text
    }

    private var tooltip: String {
        var lines = ["\(title) — \(activity)"]
        lines.append([session.name, session.source].compactMap { $0 }.joined(separator: " · "))
        if let cwd = session.cwd { lines.append(cwd) }
        return lines.joined(separator: "\n")
    }

    static func glyph(for source: String) -> String {
        switch source {
        case "claude-code": return "asterisk"
        case "codex": return "chevron.left.forwardslash.chevron.right"
        case "workflow": return "point.3.connected.trianglepath.dotted"
        case "gemini-cli": return "sparkle"
        default: return "terminal"
        }
    }

    /// "<1m", "4m", "1h 5m", "2d". Minute resolution keeps the list still.
    static func elapsed(since ms: Double, now: Date) -> String {
        let secs = max(0, now.timeIntervalSince1970 - ms / 1000)
        let mins = Int(secs / 60)
        if mins < 1 { return "<1m" }
        if mins < 60 { return "\(mins)m" }
        let hours = mins / 60
        if hours < 24 { return mins % 60 == 0 ? "\(hours)h" : "\(hours)h \(mins % 60)m" }
        return "\(hours / 24)d"
    }
}

/// Shows row actions as a native menu at the pointer (left-click on a row).
enum ActionMenu {
    static func popUp(_ actions: [RowAction]) {
        let menu = NSMenu()
        for a in actions {
            if a.separated && !menu.items.isEmpty { menu.addItem(.separator()) }
            let item = ClosureMenuItem(title: a.title, run: a.run)
            item.image = NSImage(systemSymbolName: a.systemImage, accessibilityDescription: nil)
            menu.addItem(item)
        }
        // Same route as a right-click context menu, anchored to the click that
        // triggered the row's action, so the menu bar panel stays open under it.
        // (A free-floating popUp(in: nil) closes the panel and the menu with it.)
        if let event = NSApp.currentEvent, let view = event.window?.contentView {
            NSMenu.popUpContextMenu(menu, with: event, for: view)
        }
    }
}

private final class ClosureMenuItem: NSMenuItem {
    private let run: () -> Void

    init(title: String, run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    @objc private func fire() { run() }
}
