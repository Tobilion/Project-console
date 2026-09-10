// User account menu (Phase I portal, 2026-09-10): header avatar dropdown for switching
// users, opening profile/appearance/settings/notifications, and logging out.
//
// Adapted from the supplied user-dropdown reference — deliberately NOT a verbatim copy:
// - lucide-react icons instead of @iconify/react (Iconify fetches SVGs from a CDN at
//   runtime; this app is offline-first, so every icon must be bundled).
// - No demo cruft: no hardcoded demo user, no external avatar URL, no Upgrade-to-Pro /
//   Referrals / Download-app / What's-new rows (none of those exist in this app).
// - No presence/status submenu (no presence backend exists — a fake status picker would
//   be a dead control). The badge shows the real role (admin/user) instead.
// - Theme tokens (panel/fg/border) instead of gray-*/dark: variants — this repo themes
//   via [data-theme], never dark: utilities.
// - Fully typed props (repo lint is strict; the reference's untyped render callbacks
//   would not pass tsc).
// Switching accounts always re-authenticates: picking another account calls
// onAction('switch', username) and the parent logs out to the LoginScreen (which
// pre-fills the picked name) — there is deliberately no passwordless hop between users.

import * as React from "react"
import { User, Sun, Settings, Bell, Users, LogOut, Check } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export interface DropdownAccount {
  username: string;
  role: string;
}

export type UserDropdownAction =
  | 'profile'
  | 'appearance'
  | 'settings'
  | 'notifications'
  | 'switch'
  | 'logout';

function initialsOf(name: string): string {
  const clean = name.trim();
  if (!clean) return '??';
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return clean.slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function UserDropdown({
  displayName,
  username,
  role,
  accounts = [],
  onAction = () => {},
}: {
  /** Human display name (profile name, falls back to username at the call site). */
  displayName: string;
  username: string;
  role: string;
  /** Other known accounts for the switcher (from GET /api/auth/users). */
  accounts?: DropdownAccount[];
  onAction?: (action: UserDropdownAction, account?: string) => void;
}) {
  const others = accounts.filter((a) => a.username !== username);
  const initials = initialsOf(displayName || username);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account: ${username}`}
          title={`Signed in as ${username} — account menu`}
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar className="cursor-pointer size-9 border border-border-soft bg-panel-strong">
            <AvatarFallback className="bg-panel-strong text-fg-strong text-xs font-bold">
              {initials}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-[280px] rounded-2xl bg-panel border-border-strong p-1" align="end">
        <div className="flex items-center gap-2 p-2">
          <Avatar className="size-10 border border-border-soft bg-panel-strong">
            <AvatarFallback className="bg-panel-strong text-fg-strong text-sm font-bold">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-fg-strong truncate">{displayName || username}</h3>
            <p className="text-fg-dim text-xs truncate">@{username}</p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              'text-[11px] capitalize',
              role === 'admin' ? 'border-accent-blue/40 text-accent-blue' : 'text-fg-dim',
            )}
          >
            {role}
          </Badge>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem className="p-2 rounded-lg cursor-pointer" onClick={() => onAction('profile')}>
            <span className="flex items-center gap-1.5 font-medium">
              <User className="size-5 text-fg-dim" /> Your profile
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem className="p-2 rounded-lg cursor-pointer" onClick={() => onAction('appearance')}>
            <span className="flex items-center gap-1.5 font-medium">
              <Sun className="size-5 text-fg-dim" /> Appearance
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem className="p-2 rounded-lg cursor-pointer" onClick={() => onAction('settings')}>
            <span className="flex items-center gap-1.5 font-medium">
              <Settings className="size-5 text-fg-dim" /> Settings
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem className="p-2 rounded-lg cursor-pointer" onClick={() => onAction('notifications')}>
            <span className="flex items-center gap-1.5 font-medium">
              <Bell className="size-5 text-fg-dim" /> Notifications
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="cursor-pointer p-2 rounded-lg">
              <span className="flex items-center gap-1.5 font-medium text-fg-dim">
                <Users className="size-5 text-fg-dim" /> Switch account
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="bg-panel border-border-strong min-w-[200px]">
                {others.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-fg-dim">No other accounts on this server.</p>
                )}
                {others.map((a) => (
                  <DropdownMenuItem
                    key={a.username}
                    className="p-2 rounded-lg cursor-pointer"
                    onClick={() => onAction('switch', a.username)}
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      <Avatar className="size-6 border border-border-soft bg-panel-strong">
                        <AvatarFallback className="bg-panel-strong text-fg-strong text-[10px] font-bold">
                          {initialsOf(a.username)}
                        </AvatarFallback>
                      </Avatar>
                      @{a.username}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuItem className="p-2 rounded-lg cursor-pointer" onClick={() => onAction('logout')}>
            <span className="flex items-center gap-1.5 font-medium">
              <LogOut className="size-5 text-fg-dim" /> Log out
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <p className="px-2 py-1.5 text-[10px] text-fg-faint flex items-center gap-1">
          <Check className="size-3 text-accent-green" /> Signed in — sessions expire after 30 days idle
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default UserDropdown;
