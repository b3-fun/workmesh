import AppKit
import SwiftUI

extension Color {
    /// The Workmesh/B3OS accent (#0c68e9), lifted in dark mode so it reads on
    /// the dark material. Used sparingly: the Open board button and links.
    static let workmeshAccent = Color(nsColor: NSColor(name: "workmeshAccent") { appearance in
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return dark
            ? NSColor(srgbRed: 0x4C / 255, green: 0x93 / 255, blue: 0xF5 / 255, alpha: 1)
            : NSColor(srgbRed: 0x0C / 255, green: 0x68 / 255, blue: 0xE9 / 255, alpha: 1)
    })
}

/// A teammate's GitHub avatar, with their initials while it loads, when it
/// fails, or when there's no GitHub login.
struct Avatar: View {
    let name: String
    let github: String?
    var size: CGFloat = 20

    var body: some View {
        ZStack {
            Circle().fill(Color.primary.opacity(0.1))
            Text(Self.initials(name))
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(.secondary)
            if let url {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image.resizable().interpolation(.high).scaledToFill()
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
    }

    private var url: URL? {
        guard let github, !github.isEmpty,
              github.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") })
        else { return nil }
        // github.com/<login>.png redirects to the avatar, and 404s for an unknown
        // login (avatars.githubusercontent.com/<login> serves a stock image
        // instead), so a wrong login falls back to initials.
        return URL(string: "https://github.com/\(github).png?size=64")
    }

    /// "An" → "A", "Mitch Lee" → "ML".
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "." }).filter { !$0.isEmpty }
        guard let first = words.first?.first else { return "?" }
        if words.count > 1, let last = words.last?.first { return "\(first)\(last)".uppercased() }
        return String(first).uppercased()
    }
}

/// Presence: a green dot while a device of theirs reached the hub lately, a
/// hollow ring otherwise.
struct PresenceDot: View {
    let online: Bool

    var body: some View {
        Group {
            if online {
                Circle().fill(Color.green)
            } else {
                Circle().strokeBorder(Color.secondary.opacity(0.7), lineWidth: 1)
            }
        }
        .frame(width: 6, height: 6)
        .accessibilityLabel(online ? "Online" : "Offline")
    }
}

/// One teammate: avatar, name, presence, their agents in a few words. Click
/// to show their sessions.
struct PersonRow: View {
    let person: TeamPerson
    let expanded: Bool
    let expandable: Bool
    let toggle: () -> Void
    @State private var hovering = false

    var body: some View {
        Button {
            if expandable { toggle() }
        } label: {
            HStack(spacing: 8) {
                Avatar(name: person.name, github: person.github)
                Text(person.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(person.online ? .primary : .secondary)
                    .lineLimit(1)
                PresenceDot(online: person.online)
                Spacer(minLength: 8)
                Text(Self.summary(person))
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .frame(width: 10)
                    .opacity(expandable ? 1 : 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.primary.opacity(hovering && expandable ? 0.08 : 0))
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(person.email.map { "\(person.name) · \($0)" } ?? person.name)
        .accessibilityLabel("\(person.name), \(Self.summary(person))")
    }

    /// "2 working · 1 waiting", else "idle" or "offline".
    static func summary(_ p: TeamPerson) -> String {
        var parts: [String] = []
        if p.counts.working > 0 { parts.append("\(p.counts.working) working") }
        if p.counts.waiting > 0 { parts.append("\(p.counts.waiting) waiting") }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        return p.online ? "idle" : "offline"
    }
}

/// A teammate's session, nested under them: same row as a local one.
struct TeamSessionRow: View {
    let session: TeamSession
    let now: Date
    let actions: [RowAction]

    var body: some View {
        AgentRow(
            source: session.source,
            tint: tint,
            title: session.name.isEmpty ? (session.repo.map(NeedItem.repoName) ?? session.source) : session.name,
            subagents: session.subagents,
            elapsed: session.stateSince.map { AgentRow.elapsed(since: $0, now: now) } ?? "",
            detail: session.now ?? session.state,
            trailingDetail: session.repo.map(NeedItem.repoName),
            tooltip: tooltip,
            actions: actions,
            dimmed: session.state == "idle" || session.state == "offline",
            inset: 28
        )
    }

    private var tint: Color {
        session.state == "working" ? .green : .secondary
    }

    private var tooltip: String {
        var lines = ["\(session.name) — \(session.now ?? session.state)"]
        let place = [session.repo, session.branch].compactMap { $0 }.joined(separator: " @ ")
        if !place.isEmpty { lines.append(place) }
        lines.append("\(session.owner) · \(session.source) · \(session.state)")
        return lines.joined(separator: "\n")
    }
}
