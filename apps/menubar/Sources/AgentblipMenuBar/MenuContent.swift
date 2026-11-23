import SwiftUI

/// The dropdown: what Slack shows (and the sync control) on top, the live
/// session list grouped by what it needs from you, settings tucked in a menu.
struct MenuContent: View {
    @ObservedObject var model: AppModel
    @AppStorage("idleExpanded") private var idleExpanded = false

    /// Beyond this many visible rows the list scrolls.
    private let maxRowsBeforeScroll = 9

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.reachable, let s = model.state {
                header(s)
                Divider().padding(.horizontal, 14)
                list(s)
            } else {
                offline
            }
            Divider().padding(.horizontal, 14)
            footer
        }
        .frame(width: 340)
    }

    // MARK: - Header: the Slack line + sync control

    private func header(_ s: DaemonState) -> some View {
        let line = slackLine(s)
        return HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: line.symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 14)
            // Up to Slack's 100 characters: two lines, so "· 1 waiting on me" isn't cut.
            Text(line.text)
                .font(.system(size: 12))
                .foregroundStyle(line.live ? .primary : .secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .help(line.help)
            if let err = s.lastError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(.orange)
                    .help("Last Slack update failed: \(err)")
            }
            Spacer(minLength: 8)
            syncControl(s)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private struct SlackLine {
        let symbol: String
        let text: String
        let help: String
        let live: Bool
    }

    private func slackLine(_ s: DaemonState) -> SlackLine {
        if s.paused, let until = s.pausedUntil {
            let at = Date(timeIntervalSince1970: until / 1000)
            return SlackLine(symbol: "moon.zzz", text: "Snoozed until \(Self.clock(at))",
                             help: "Slack sync resumes on its own at \(Self.clock(at)).", live: false)
        }
        if s.paused {
            return SlackLine(symbol: "pause.circle", text: "Slack sync paused",
                             help: "Your Slack status is cleared until you resume.", live: false)
        }
        if s.ownership.backedOff {
            return SlackLine(symbol: "person.crop.circle", text: "Your own Slack status is up",
                             help: "agentblip leaves it alone and picks up again when it clears.", live: false)
        }
        if let f = s.formatted {
            return SlackLine(symbol: "bubble.left.fill", text: f.text,
                             help: "Your Slack status: \(f.text)", live: true)
        }
        return SlackLine(symbol: "bubble.left", text: "Slack status clear",
                         help: "No agents are working, so agentblip shows nothing.", live: false)
    }

    @ViewBuilder
    private func syncControl(_ s: DaemonState) -> some View {
        if s.paused {
            Button("Resume") { model.resume() }
                .controlSize(.small)
        } else {
            Menu {
                ForEach(SnoozePreset.allCases, id: \.self) { p in
                    Button("Snooze \(p.title)") { model.snooze(p) }
                }
                Divider()
                Button("Pause Until I Resume") { model.pause() }
            } label: {
                Image(systemName: "moon.zzz")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Snooze Slack sync")
            .accessibilityLabel("Snooze Slack sync")
        }
    }

    // MARK: - Session list

    private func list(_ s: DaemonState) -> some View {
        let visible = s.snapshot.sessions.filter { $0.foldedInto == nil }
        let groups = SessionGroup.allCases.compactMap { g -> (SessionGroup, [AgentSession])? in
            let rows = Self.order(visible.filter { SessionGroup.of($0) == g }, in: g)
            return rows.isEmpty ? nil : (g, rows)
        }
        let rowCount = groups.reduce(0) { n, g in
            n + (g.0 == .idle && !idleExpanded ? 0 : g.1.count)
        }
        let content = VStack(alignment: .leading, spacing: 0) {
            if groups.isEmpty {
                Text("No agents running")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
            }
            ForEach(groups, id: \.0) { group, rows in
                section(group, rows)
            }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 6)

        return Group {
            if rowCount > maxRowsBeforeScroll {
                ScrollView { content }.frame(height: 460)
            } else {
                content
            }
        }
    }

    @ViewBuilder
    private func section(_ group: SessionGroup, _ rows: [AgentSession]) -> some View {
        let now = Date()
        if group == .idle {
            Button {
                idleExpanded.toggle()
            } label: {
                sectionHeader(group, count: rows.count, chevron: idleExpanded ? "chevron.down" : "chevron.right")
            }
            .buttonStyle(.plain)
            if idleExpanded {
                ForEach(rows) { row($0, group, now) }
            }
        } else {
            sectionHeader(group, count: rows.count, chevron: nil)
            ForEach(rows) { row($0, group, now) }
        }
    }

    private func sectionHeader(_ group: SessionGroup, count: Int, chevron: String?) -> some View {
        HStack(spacing: 4) {
            Text(group.title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(group == .needsYou ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
            if count > 1 || chevron != nil {
                Text("\(count)")
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if let chevron {
                Image(systemName: chevron)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 9)
        .padding(.bottom, 3)
        .contentShape(Rectangle())
    }

    private func row(_ s: AgentSession, _ group: SessionGroup, _ now: Date) -> some View {
        SessionRow(session: s, group: group, now: now, actions: actions(for: s, group))
    }

    private func actions(for s: AgentSession, _ group: SessionGroup) -> [RowAction] {
        var out: [RowAction] = []
        if let name = s.name {
            out.append(RowAction(title: "Copy Name", systemImage: "doc.on.doc") { model.copy(name) })
        }
        out.append(RowAction(title: "Copy Session ID", systemImage: "number") { model.copy(s.sessionId) })
        if let cwd = s.cwd, FileManager.default.fileExists(atPath: cwd) {
            out.append(RowAction(title: "Reveal in Finder", systemImage: "folder") { model.revealInFinder(cwd) })
        }
        // A working session would reappear with its next event; dismiss is for
        // a stale wait, a finished turn, or background work you've seen.
        if group != .working {
            out.append(RowAction(title: "Dismiss", systemImage: "xmark.circle", separated: true) {
                model.dismiss(s)
            })
        }
        return out
    }

    /// Stable order so rows don't jump on every tool call: the longest wait
    /// first under "Needs you", otherwise by name.
    static func order(_ rows: [AgentSession], in group: SessionGroup) -> [AgentSession] {
        if group == .needsYou {
            return rows.sorted { ($0.stateSince ?? $0.updatedAt) < ($1.stateSince ?? $1.updatedAt) }
        }
        return rows.sorted {
            let a = ($0.project ?? $0.name ?? "").lowercased()
            let b = ($1.project ?? $1.name ?? "").lowercased()
            return a == b ? $0.startedAt < $1.startedAt : a < b
        }
    }

    // MARK: - Offline

    private var offline: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("The agentblip daemon isn't running", systemImage: "circle.dashed")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            HStack {
                Text("agentblip start --detach")
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                Spacer()
                Button {
                    model.copy("agentblip start --detach")
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy")
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05)))
        }
        .padding(14)
    }

    // MARK: - Footer: settings menu + quit

    private var footer: some View {
        HStack {
            Menu {
                if let c = model.config {
                    Picker("Slack Detail", selection: Binding(
                        get: { c.granularity },
                        set: { model.setGranularity($0) }
                    )) {
                        Text("Off").tag("off")
                        Text("Presence").tag("presence")
                        Text("Count").tag("count")
                        Text("Activity").tag("activity")
                    }
                    Picker("When My Status Is Set", selection: Binding(
                        get: { c.statusPolicy },
                        set: { model.setPolicy($0) }
                    )) {
                        Text("Leave It").tag("respect")
                        Text("Replace It, Then Restore").tag("overwrite")
                    }
                    Toggle("Lead With Repo Name", isOn: Binding(
                        get: { c.repoPrefix },
                        set: { model.setRepoPrefix($0) }
                    ))
                    Divider()
                }
                Toggle("Notify When an Agent Needs Me", isOn: $model.notifyOnNeedsYou)
                Divider()
                Button("Open Config File…") { model.openConfigFile() }
            } label: {
                Image(systemName: "gearshape")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Settings")
            .accessibilityLabel("Settings")

            Spacer()

            Button("Quit") { model.quit() }
                .buttonStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .keyboardShortcut("q")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private static func clock(_ date: Date) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
        f.doesRelativeDateFormatting = true
        return f.string(from: date)
    }
}
