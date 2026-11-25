# Linux

`workmesh init` works the same on Linux with Node 20, 22 or 24. What differs is keeping the daemon alive: on a box
you SSH into, systemd stops your user services when you log out, and the board then shows you offline. `init` handles
that by turning on lingering.

## With systemd

Ubuntu, Debian, Fedora, and WSL with systemd. The daemon runs as a user unit,
`~/.config/systemd/user/workmesh.service`, which restarts it after a crash.

systemd stops a user's services about 10 seconds after their last session ends, unless the user lingers. `init` turns
lingering on for you (`loginctl enable-linger`), so the daemon keeps running after you log out and starts at boot.
Where only an admin may do that (no polkit, as on a minimal Debian), `init` offers to run this in the terminal, and
prints it otherwise:

```bash
sudo loginctl enable-linger $USER
```

`--no-linger` leaves lingering off. `loginctl disable-linger` undoes it.

Check the daemon with:

```bash
workmesh doctor                    # "logout" line: lingering on or off
systemctl --user status workmesh
journalctl --user -u workmesh      # its log under systemd
```

## Without systemd

A container, WSL without systemd, or a minimal VM. The daemon runs detached in the background and outlives the shell
that started it. After a reboot the next agent hook starts it again. `doctor` shows
`✓ daemon service  none (no systemd on this machine)`.

## Over SSH

- Pass `--no-open` and open the printed approve link on your laptop:
  `workmesh init https://workmesh.b3os.org --no-open`.
- Give the box its own name if its hostname is generic: `--machine b3-box`.
- Shells from `su`, `sudo -u` or cron often lack `XDG_RUNTIME_DIR`; Workmesh finds your user manager at
  `/run/user/<uid>` anyway.

## Offline after you log out

That is lingering. `workmesh doctor` names it:

```text
  ! logout             lingering is off: systemd stops the daemon when you log out (an SSH box then shows you offline on the board) → `sudo loginctl enable-linger $USER`
```

Run the command it gives, then `workmesh restart`. This is what kept a teammate's box offline on 11-25: it paired, sent
one heartbeat, and went quiet ten seconds after the SSH session ended.

## Testing changes on Linux

`scripts/smoke-linux/smoke.sh` runs `init` on fresh Docker boxes (Node 20, 22 and 24, with and without systemd, over
SSH) and checks that each stays online after logout. See [CONTRIBUTING](../../CONTRIBUTING.md#smoke-tests).
