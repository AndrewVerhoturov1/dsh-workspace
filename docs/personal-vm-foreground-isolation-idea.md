# Personal VM foreground isolation idea

Status: **deferred / idea only**. Current priority remains completing Postman M6.

## Motivation

The current Postman Desktop transport depends on the Windows interactive desktop and must be able to activate the unified ChatGPT Desktop host safely before navigating to ordinary Chat, proving Fresh, and submitting a prompt.

A live M6 attempt showed that an unrelated foreground application (a Unity game) can keep foreground ownership and cause the bridge to fail closed before Send. That is the correct safety behavior, but it means normal personal activity on the same host can interfere with autonomous Desktop transport.

The proposed long-term mitigation is to reserve the main Windows desktop for Harness/Postman/ChatGPT and move the user's personal activity into a separate virtual machine.

## Proposed architecture

```text
MAIN PC / Windows 10 Pro HOST
├── Harness
├── POSTMAN
├── ChatGPT Desktop / Codex
├── GitHub runner and other work automation
└── Hyper-V
    └── PERSONAL-VM
        └── separate Windows guest
            ├── browser
            ├── messengers
            ├── video
            └── ordinary personal applications
                 ▲
                 │ RDP over local network
                 │
OLD LAPTOP
└── display + keyboard + mouse for PERSONAL-VM
```

The old laptop is only the RDP client. Computation for the personal environment still happens on the main PC inside the Hyper-V guest.

## Isolation model

`PERSONAL-VM` is a separate operating system with its own:

- desktop and foreground state;
- user session;
- registry and services;
- installed applications;
- virtual network adapter;
- virtual disk and guest filesystem.

The guest filesystem is not shared with the host by default. The host stores a `.vhdx` file, but inside the VM that file appears as the guest's own disk. Host `C:\Users\...` and guest `C:\Users\...` are unrelated filesystems unless explicit sharing/redirection is later enabled.

Host and guest still share physical resources through Hyper-V:

- CPU;
- RAM;
- storage bandwidth;
- physical network connectivity.

This means resource contention is possible, but keyboard/mouse/foreground activity inside an RDP session to the guest should not change the foreground window of the host Windows desktop.

## Why ordinary alternatives are insufficient

The following do **not** provide the required foreground isolation:

- Windows Virtual Desktops (`Win+Ctrl+D`);
- a second physical monitor in the same Windows session;
- a virtual/dummy display in the same Windows session;
- merely opening a VM console window on the host and using it interactively;
- a second ordinary user desktop if it still requires taking over the same interactive host session.

The selected concept is a true Hyper-V guest plus RDP from another physical device.

## Current host discovery

Discovery performed on 2026-08-30 without system changes:

- Windows 10 Pro 22H2, build 19045, x64;
- AMD Ryzen 7 1700, 8 cores / 16 logical processors;
- hardware virtualization enabled;
- a hypervisor is already active;
- Hyper-V services (`vmms`, `vmcompute`, `hvhost`, `hns`) are running;
- Hyper-V PowerShell module and `Get-VM` are available;
- WSL/WSL2 infrastructure is present;
- Docker Desktop is installed;
- active VPN/TUN networking is present;
- current primary physical network is Wi-Fi;
- 31.95 GiB physical RAM;
- approximately 12 GiB free during discovery;
- NVIDIA GeForce RTX 3060 present;
- games/GPU passthrough are not a requirement for the personal VM.

No Hyper-V features, network adapters, firewall rules, RDP settings, power settings, or VM configuration were changed during discovery.

## Preliminary VM profile

Deferred proposal, subject to re-check before implementation:

```text
Name:            PERSONAL-VM
Generation:      2
Guest OS:        Windows 10 Pro (chosen for compatibility; lifecycle/ESU must be considered)
vCPU:            4
Memory:          Dynamic Memory
Startup RAM:     ~6 GiB
Minimum RAM:     ~4 GiB
Maximum RAM:     ~8 GiB
VHDX:            dynamically expanding
VHDX max:        ~80 GiB
GPU passthrough: not required
Access:          RDP from old laptop over private LAN only
```

The guest Windows edition must support Remote Desktop Host functionality.

## Storage idea

The preferred location is the host NVMe if enough free space is available because a VM on the SATA HDD will feel noticeably slower for browser-heavy use.

Before creating an ~80 GiB dynamic VHDX on the system NVMe, target roughly 130-150 GiB free space so the host retains healthy headroom for Windows, pagefile, updates, ChatGPT, Harness, and temporary files as the VHDX grows.

If that headroom is unavailable, `D:\Hyper-V\PERSONAL-VM` is a workable slower alternative.

## Network idea

The main PC cannot practically be connected to the router by Ethernet, so the likely implementation must work over Wi-Fi.

Preferred logical topology:

```text
router / 192.168.0.0/24
├── Wi-Fi -> MAIN PC HOST
│            └── Hyper-V -> PERSONAL-VM (192.168.0.x)
└── Wi-Fi -> OLD LAPTOP (192.168.0.x)
             └── RDP -> PERSONAL-VM
```

An External Hyper-V virtual switch bound to the host Wi-Fi adapter is the most direct model because the VM can receive its own LAN address and the laptop can RDP to it directly.

Risks to handle carefully during implementation:

- creating/rebinding an external switch can briefly interrupt host Wi-Fi;
- VPN/TUN adapters can complicate routing;
- WSL/Docker already use Hyper-V networking;
- any network change must have an explicit rollback plan;
- RDP port 3389 must never be exposed through router port forwarding to the Internet.

A NAT design can be reconsidered if an external Wi-Fi switch proves unstable, but stable inbound RDP from the laptop must remain simple and deterministic.

## Security defaults

For the first implementation, prefer isolation over convenience:

- separate guest user;
- Network Level Authentication for RDP;
- RDP allowed only on the private LAN / required subnet;
- no Internet-facing RDP port forwarding;
- host drives not redirected into the guest by default;
- shared folders disabled initially;
- shared clipboard disabled initially if practical;
- USB redirection disabled unless explicitly needed;
- work credentials/repos remain on the host;
- personal browser/messengers remain in the guest.

## Acceptance criterion

The purpose of the VM is not merely to run another desktop. It must prove that personal activity no longer interferes with Postman's host Desktop transport.

Final acceptance test after the VM is eventually built:

1. On the host, ChatGPT Desktop is available to Postman.
2. Postman repeatedly executes the production-style Desktop sequence:
   `Codex -> Chat -> Fresh -> SubmitOnly`.
3. At the same time, the user actively works from the old laptop through RDP into `PERSONAL-VM`:
   - types continuously;
   - switches guest windows;
   - browses the web;
   - uses ordinary personal applications.
4. The host foreground remains unaffected by guest interaction.
5. Required target: **10/10 SubmitOnly PASS** with no manual host interaction.

This is the proof that the personal VM solved the original foreground-conflict problem.

## Important caveat: ChatGPT window geometry

The Desktop bridge must not assume that an arbitrarily tiny or narrow ChatGPT Desktop window is representative of normal operation.

A very small/narrow window can materially change an Electron/Chromium/UIA surface:

- controls may reflow or collapse;
- labels/buttons can move into overflow menus;
- UIA nodes can be recreated;
- text can be split differently across accessible nodes;
- `BoundingRectangle` values change;
- controls may be reported `IsOffscreen=true` even though they are interactable after resize/activation;
- the ordinary Chat/Codex layout can switch responsive modes;
- Send/composer semantics may differ from a normal-sized desktop window.

Therefore M6 validation should either:

1. test against a documented normal production window size/state; or
2. explicitly prove that supported responsive size ranges are safe.

A test harness should not silently force ChatGPT into an unusually tiny geometry and then treat resulting UIA failures as representative production failures.

Window normalization must remain safety-conscious: resize/restore only after the correct ChatGPT host HWND is identified, and never weaken Fresh/Send confirmation merely to make a narrow layout pass.

## Priority

This proposal is intentionally deferred.

Current priority is:

```text
Complete Postman M6
-> single-agent full live
-> A+B live
-> duplicate suppression live
-> offline recovery live
-> regression
-> merge PR #22 only after PASS
```

Do not interrupt Postman M6 work to build `PERSONAL-VM` unless explicitly requested later.
