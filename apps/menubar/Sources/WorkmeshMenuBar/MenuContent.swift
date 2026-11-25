import SwiftUI

/// The dropdown: what Slack shows (and the sync control) on top; then what
/// needs you (this Mac and your other machines), your sessions here, and your
/// team; the hub connection, Open board and settings at the bottom.
struct MenuContent: View {
    @ObservedObject var model: AppModel
    @AppStorage("idleExpanded") private var idleExpanded = false
    @State private var listHeight: CGFloat = 0

    /// Beyond this many visible rows the list scrolls.
    private let maxRowsBeforeScroll = 9
    private let maxListHeight: CGFloat = 460
    static let defaultHub = "https://workmesh.b3os.org"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.reachable, let s = model.state {
                header(s)
                Divider().padding(.horizontal, 14)
                list(s)
            } else {
                offline
            }
            if let offer = model.updateOffer {
                Divider().padding(.horizontal, 14)
                updateItem(offer)
            }
            Divider().padding(.horizontal, 14)
            footer
        }
        .frame(width: 340)
        .onAppear { model.menuOpen = true }
        .onDisappear { model.menuOpen = false }
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
                             help: "Workmesh leaves it alone and picks up again when it clears.", live: false)
        }
        if let f = s.formatted {
            return SlackLine(symbol: "bubble.left.fill", text: f.text,
                             help: "Your Slack status: \(f.text)", live: true)
        }
        return SlackLine(symbol: "bubble.left", text: "Slack status clear",
                         help: "No agents are working, so Workmesh shows nothing.", live: false)
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

    // MARK: - The list: needs you, this Mac, the team

    /// What the team area shows, read straight off GET /team.
    private enum TeamArea {
        case none // older daemon, or no team view yet
        case connectHint // not paired with a hub
        case reconnect(String) // the hub rejected this device's token
        case note(String, help: String?) // one quiet line
        case people(TeamView, [TeamPerson])
    }

    private var teamArea: TeamArea {
        guard let t = model.team else { return .none }
        guard t.enabled else { return .connectHint }
        if t.halted { return .reconnect("workmesh hub connect \(t.hubUrl ?? Self.defaultHub)") }
        if t.available == false { return .note("This hub has no team view yet", help: nil) }
        guard let v = t.team else {
            if let e = t.error { return .note("Team view unavailable", help: e) }
            return .none
        }
        return .people(v, v.teammates)
    }

    private func list(_ s: DaemonState) -> some View {
        let now = Date()
        let hubNow = hubClock(now)
        let area = teamArea
        var liveTeam: TeamView?
        if case .people(let v, _) = area { liveTeam = v }

        let visible = s.snapshot.sessions.filter { $0.foldedInto == nil }
        let needs = NeedItem.merge(local: visible, team: liveTeam, deviceId: model.team?.deviceId)
        let groups = [SessionGroup.working, .background, .idle].compactMap { g -> (SessionGroup, [AgentSession])? in
            let rows = Self.order(visible.filter { SessionGroup.of($0) == g }, in: g)
            return rows.isEmpty ? nil : (g, rows)
        }

        let holds = model.team?.coord?.holds ?? []
        let unread = Array((model.team?.coord?.unread ?? []).prefix(Self.maxMessages))
        let allHandoffs = model.team?.delegate?.shownHandoffs ?? []
        let allApprovals = model.team?.delegate?.shownApprovals ?? []
        let handoffs = Array(allHandoffs.prefix(Self.maxMessages))
        let approvals = Array(allApprovals.prefix(Self.maxMessages))
        // Handoff and approval rows carry a line of buttons: about two rows tall.
        var rowCount = needs.count + holds.count + unread.count + 2 * (handoffs.count + approvals.count)
            + groups.reduce(0) { n, g in n + (g.0 == .idle && !idleExpanded ? 0 : g.1.count) }
        switch area {
        case .none: break
        case .connectHint, .reconnect, .note: rowCount += 1
        case .people(let v, let people):
            rowCount += max(1, people.count)
            for p in people where model.expandedPeople.contains(p.name) { rowCount += v.sessions(of: p).count }
        }

        let content = VStack(alignment: .leading, spacing: 0) {
            if needs.isEmpty && groups.isEmpty {
                Text("No agents running")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
            }
            if !needs.isEmpty {
                sectionHeader("Needs you", count: needs.count > 1 ? "\(needs.count)" : nil, urgent: true)
                ForEach(needs) { needRow($0, now: now, hubNow: hubNow) }
            }
            if !holds.isEmpty {
                sectionHeader("On hold", count: holds.count > 1 ? "\(holds.count)" : nil, urgent: true)
                ForEach(holds) { holdRow($0, hubNow: hubNow) }
            }
            if !unread.isEmpty {
                sectionHeader("Messages for your agents", count: "\(model.team?.coord?.unread.count ?? unread.count)")
                ForEach(unread) { messageRow($0, hubNow: hubNow) }
            }
            if !handoffs.isEmpty {
                sectionHeader("Handoffs for you", count: "\(allHandoffs.count)")
                ForEach(handoffs) { handoffRow($0, hubNow: hubNow) }
            }
            if !approvals.isEmpty {
                sectionHeader("Approvals", count: "\(allApprovals.count)", urgent: allApprovals.contains(where: \.canDecide))
                ForEach(approvals) { approvalRow($0, hubNow: hubNow) }
            }
            ForEach(groups, id: \.0) { group, rows in
                section(group, rows, now)
            }
            teamSection(area, hubNow: hubNow)
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 6)

        return Group {
            if rowCount > maxRowsBeforeScroll {
                ScrollView {
                    content.background(GeometryReader { g in
                        Color.clear.preference(key: ListHeightKey.self, value: g.size.height)
                    })
                }
                .frame(height: min(listHeight > 0 ? listHeight : maxListHeight, maxListHeight))
                .onPreferenceChange(ListHeightKey.self) { listHeight = $0 }
            } else {
                content
            }
        }
    }

    @ViewBuilder
    private func section(_ group: SessionGroup, _ rows: [AgentSession], _ now: Date) -> some View {
        if group == .idle {
            Button {
                idleExpanded.toggle()
            } label: {
                sectionHeader(group.title, count: "\(rows.count)", chevron: idleExpanded ? "chevron.down" : "chevron.right")
            }
            .buttonStyle(.plain)
            if idleExpanded {
                ForEach(rows) { row($0, group, now) }
            }
        } else {
            sectionHeader(group.title, count: rows.count > 1 ? "\(rows.count)" : nil)
            ForEach(rows) { row($0, group, now) }
        }
    }

    private func sectionHeader(_ title: String, count: String?, urgent: Bool = false, chevron: String? = nil) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(urgent ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
            if let count {
                Text(count)
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

    /// A wait on me: the local row when it's on this Mac (with the hub's reason
    /// when the hub has one), else the hub's item from another machine.
    /// Messages, handoffs or approvals shown at most; each header counts them all.
    private static let maxMessages = 4

    /// v1: a teammate held one of this Mac's agents (every tool call is refused until they lift it).
    private func holdRow(_ h: CoordHold, hubNow: Date) -> some View {
        let who = h.name ?? "An agent"
        let detail = "Held by \(h.by)" + (h.reason.map { ": \($0)" } ?? "")
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: "pause.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(.orange)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(who).font(.system(size: 12, weight: .medium)).lineLimit(1)
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 4)
            if let since = h.since {
                Text(AgentRow.elapsed(since: since, now: hubNow))
                    .font(.system(size: 11)).monospacedDigit().foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .help("\(who): \(detail). Its tool calls are refused until \(h.by) lifts the hold on the board.")
        .accessibilityElement(children: .combine)
    }

    /// v1: a teammate's message that hasn't reached its agent yet (it arrives at the agent's next tool call).
    private func messageRow(_ m: CoordMessage, hubNow: Date) -> some View {
        let from = m.fromSession.map { "\(m.from) (\($0))" } ?? m.from
        let to = m.name.map { " → \($0)" } ?? ""
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: "envelope")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(from + to).font(.system(size: 12, weight: .medium)).lineLimit(1)
                Text(m.text).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 4)
            if let ts = m.ts {
                Text(AgentRow.elapsed(since: ts, now: hubNow))
                    .font(.system(size: 11)).monospacedDigit().foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .help("\(from)\(to): \(m.text)\nDelivered at the agent's next tool call.")
        .accessibilityElement(children: .combine)
    }

    /// v2: a task a teammate handed me (Accept starts an agent for it on this
    /// Mac), or one already running here.
    private func handoffRow(_ h: DelegateHandoff, hubNow: Date) -> some View {
        let from = h.fromSession.map { "\(h.from) (\($0))" } ?? h.from
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: h.runningHere ? "play.circle" : "tray.and.arrow.down")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(Self.oneLine(h.task))
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(h.origin).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                if h.runningHere {
                    delegateNote("Running here")
                } else {
                    delegateActions(h.id, yes: "Accept", no: "Decline") { model.answerHandoff(h.id, accept: $0) }
                }
            }
            Spacer(minLength: 4)
            if let at = h.createdAt {
                Text(AgentRow.elapsed(since: at, now: hubNow))
                    .font(.system(size: 11)).monospacedDigit().foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .help([from + " handed you: " + h.task,
               [h.repo, h.issue].compactMap { $0 }.joined(separator: " · "),
               h.runningHere ? "Running on this Mac." : "Accept starts an agent for it on this Mac."]
              .filter { !$0.isEmpty }.joined(separator: "\n"))
        .accessibilityElement(children: .contain)
    }

    /// v2: an action an agent must not take without a person's yes: one of
    /// this Mac's agents asking, or a teammate's agent I may decide for.
    private func approvalRow(_ a: DelegateApproval, hubNow: Date) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "hand.raised")
                .font(.system(size: 12))
                .foregroundStyle(a.canDecide ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(Self.oneLine(a.detail))
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(a.ask).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                if a.canDecide {
                    delegateActions(a.id, yes: "Approve", no: "Deny") { model.decideApproval(a.id, approve: $0) }
                } else {
                    delegateNote("Waiting for approval")
                }
            }
            Spacer(minLength: 4)
            if let ts = a.ts {
                Text(AgentRow.elapsed(since: ts, now: hubNow))
                    .font(.system(size: 11)).monospacedDigit().foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .help("\(a.detail)\n\(a.ask)" + (a.canDecide ? "" : "\nYour approver decides on the board or in their menu bar."))
        .accessibilityElement(children: .contain)
    }

    /// The two answers, or what was answered, plus the daemon's text for a call that failed.
    @ViewBuilder
    private func delegateActions(_ id: String, yes: String, no: String, answer: @escaping (Bool) -> Void) -> some View {
        if let done = model.delegateAnswered[id] {
            delegateNote(done)
        } else {
            HStack(spacing: 6) {
                Button(yes) { answer(true) }
                Button(no) { answer(false) }
            }
            .controlSize(.small)
            .disabled(model.delegateBusy.contains(id))
            .padding(.top, 3)
        }
        if let failure = model.delegateFailed[id] {
            Text(failure)
                .font(.system(size: 11))
                .foregroundStyle(.orange)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
    }

    /// A quiet status where the buttons would be ("Running here", "Waiting for approval", "Accepted").
    private func delegateNote(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.top, 1)
    }

    /// Runs of whitespace (newlines included) as one space, for a row's clamped text.
    private static func oneLine(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    @ViewBuilder
    private func needRow(_ n: NeedItem, now: Date, hubNow: Date) -> some View {
        if let s = n.local {
            SessionRow(session: s, group: .needsYou, now: now, reason: n.remote?.reason,
                       actions: actions(for: s, .needsYou))
        } else if let r = n.remote {
            AgentRow(
                source: n.source,
                tint: .orange,
                title: n.title,
                elapsed: AgentRow.elapsed(since: n.since, now: hubNow),
                detail: r.reason ?? "needs input",
                trailingDetail: r.name == n.title ? nil : r.name,
                badge: (symbol: "desktopcomputer", help: "On another of your machines"),
                tooltip: [n.title + " — " + (r.reason ?? "needs input"),
                          [r.name, r.source, r.repo].compactMap { $0 }.joined(separator: " · "),
                          "On another of your machines"].filter { !$0.isEmpty }.joined(separator: "\n"),
                actions: hubActions(name: r.name)
            )
        }
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

    /// Rows the hub knows about but this Mac doesn't: copy the name, open the board.
    private func hubActions(name: String?) -> [RowAction] {
        var out: [RowAction] = []
        if let name, !name.isEmpty {
            out.append(RowAction(title: "Copy Name", systemImage: "doc.on.doc") { model.copy(name) })
        }
        if model.team?.boardLink != nil {
            out.append(RowAction(title: "Open Board", systemImage: "arrow.up.right.square") { model.openBoard() })
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

    // MARK: - Team

    @ViewBuilder
    private func teamSection(_ area: TeamArea, hubNow: Date) -> some View {
        switch area {
        case .none:
            EmptyView()
        case .connectHint:
            commandHint("Connect a hub", "workmesh hub connect \(Self.defaultHub)")
        case .reconnect(let command):
            commandHint("Reconnect", command)
        case .note(let text, let help):
            Text(text)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.top, 10)
                .padding(.bottom, 4)
                .help(help ?? text)
        case .people(let v, let people):
            let online = people.filter(\.online).count
            sectionHeader("Team", count: online > 0 ? "\(online) online" : nil)
            if people.isEmpty {
                Text("No teammates on this hub yet")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
            }
            ForEach(people) { p in
                let sessions = v.sessions(of: p)
                let expanded = model.expandedPeople.contains(p.name) && !sessions.isEmpty
                PersonRow(person: p, expanded: expanded, expandable: !sessions.isEmpty) {
                    model.togglePerson(p.name)
                }
                if expanded {
                    ForEach(sessions) { s in
                        TeamSessionRow(session: s, now: hubNow, actions: hubActions(name: s.name))
                    }
                }
            }
        }
    }

    /// A command with a copy button, under a short label: pairing and
    /// re-pairing hints. The command keeps to one line (a URL never splits).
    private func commandHint(_ label: String, _ command: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(command)
                    .font(.system(size: 10, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer(minLength: 0)
                Button {
                    model.copy(command)
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 10))
                }
                .buttonStyle(.borderless)
                .help("Copy")
                .accessibilityLabel("Copy command")
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    /// The hub's clock, from its serverNow at the daemon's last read, so the
    /// ages of team rows don't depend on this Mac's clock.
    private func hubClock(_ now: Date) -> Date {
        guard let t = model.team, let server = t.team?.serverNow, let fetched = t.fetchedAt else { return now }
        return now.addingTimeInterval((server - fetched) / 1000)
    }

    // MARK: - Offline

    private var offline: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("The Workmesh daemon isn't running", systemImage: "circle.dashed")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            HStack {
                Text("workmesh start --detach")
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                Spacer()
                Button {
                    model.copy("workmesh start --detach")
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

    // MARK: - Update available

    /// One calm row above the footer, only when there's something to do.
    @ViewBuilder
    private func updateItem(_ offer: UpdateOffer) -> some View {
        Group {
            switch offer {
            case .inProgress:
                UpdateRow(title: "Updating Workmesh", detail: "Show progress", busy: true) { model.showUpdateWindow() }
            case .workmesh(let u):
                UpdateRow(title: "Update available", detail: Self.versions("Workmesh", u.latest, have: u.current)) {
                    model.startUpdate()
                }
            case .app(let m, let have):
                UpdateRow(title: "Update available", detail: Self.versions("Menu bar app", m.version, have: have)) {
                    model.startAppUpdate()
                }
            case .hint(let u):
                updateHint(u)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
    }

    /// "Workmesh 0.12.1 · you have 0.12.0"
    private static func versions(_ what: String, _ latest: String?, have: String?) -> String {
        let head = latest.map { "\(what) \($0)" } ?? "A newer \(what)"
        return have.map { "\(head) · you have \($0)" } ?? head
    }

    /// A newer Workmesh this install can't take by itself: the daemon's hint,
    /// with a copy button for the command in it.
    private func updateHint(_ u: UpdateInfo) -> some View {
        let hint = u.install.hint ?? "Run `workmesh update` in a terminal."
        let command = u.hintCommand ?? (u.install.hint == nil ? "workmesh update" : nil)
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrow.down.circle")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text("Update available")
                    .font(.system(size: 12, weight: .medium))
                Text(Self.versions("Workmesh", u.latest, have: u.current))
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Text(Self.withCode(hint))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.top, 2)
            }
            Spacer(minLength: 4)
            if let command {
                Button {
                    model.copy(command)
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 10))
                }
                .buttonStyle(.borderless)
                .help("Copy \(command)")
                .accessibilityLabel("Copy command")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    /// The hint with its `backticked` parts in monospace (no other markdown).
    private static func withCode(_ text: String) -> AttributedString {
        var out = AttributedString()
        for (i, part) in text.components(separatedBy: "`").enumerated() {
            // A word joiner after each slash keeps a path like ~/src/workmesh on one line.
            var piece = AttributedString(i % 2 == 1 ? part : part.replacingOccurrences(of: "/", with: "/\u{2060}"))
            if i % 2 == 1 { piece.font = .system(size: 10.5, design: .monospaced) }
            out += piece
        }
        return out
    }

    // MARK: - Footer: settings, hub status, Open board, quit

    private var footer: some View {
        HStack(spacing: 10) {
            settingsMenu
            if model.reachable, let t = model.team, t.enabled {
                hubStatus(t)
            }
            Spacer(minLength: 6)
            if model.reachable, let t = model.team, t.enabled, let url = t.boardLink {
                Button {
                    model.openBoard()
                } label: {
                    HStack(spacing: 2) {
                        Text("Open board")
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 9, weight: .bold))
                    }
                }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.workmeshAccent)
                .help(url.absoluteString)
            }
            Button("Quit") { model.quit() }
                .buttonStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .keyboardShortcut("q")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    /// Dot + "Connected to b3os.org" over "Sharing conversation".
    private func hubStatus(_ t: TeamState) -> some View {
        let label: String
        var live = false
        if t.halted {
            label = "Reconnect needed"
        } else if t.connected == false && (t.fetchedAt == nil || t.error != nil) {
            // No good send and no good team read: a fresh team read alone
            // proves the hub answers (sends start a little after launch).
            label = "Hub unreachable"
        } else {
            label = "Connected to \(t.hubLabel)"
            live = true
        }
        var help = [t.hubUrl, t.error].compactMap { $0 }
        if t.halted { help.append("The hub no longer accepts this Mac. Pair it again.") }
        return HStack(spacing: 6) {
            PresenceDot(online: live)
            VStack(alignment: .leading, spacing: 0) {
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                if let share = t.share {
                    Text("Sharing \(share)")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }
            .lineLimit(1)
        }
        .help(help.joined(separator: "\n"))
    }

    private var settingsMenu: some View {
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
    }

    private static func clock(_ date: Date) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
        f.doesRelativeDateFormatting = true
        return f.string(from: date)
    }
}

private struct ListHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
