'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrandMark } from './brand';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/live', label: 'Live' },
  { href: '/sleep', label: 'Sleep' },
  { href: '/workouts', label: 'Workouts' },
  { href: '/breathe', label: 'Breathe' },
  { href: '/coach', label: 'Coach' },
  { href: '/device', label: 'Device' },
  { href: '/import', label: 'Import' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  return (
    <nav aria-label="Main" className="md:w-52 md:shrink-0 md:border-r border-b md:border-b-0 border-hair bg-page md:min-h-screen">
      <div className="flex items-center gap-2.5 px-4 py-4 md:py-6">
        <BrandMark />
        <div>
          <div className="text-[15px] font-semibold tracking-tight">OpenPulse</div>
          <div className="text-[11px] text-muted">local · offline</div>
        </div>
      </div>
      <ul className="flex md:flex-col gap-1 overflow-x-auto px-2 pb-3 md:pb-0">
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              aria-current={isActive(link.href) ? 'page' : undefined}
              className={`block whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive(link.href) ? 'bg-raised text-ink font-medium' : 'text-ink-2 hover:bg-card hover:text-ink'
              }`}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
