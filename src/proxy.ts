import { NextResponse, type NextRequest } from 'next/server';

/**
 * OpenPulse serves only the local machine.
 *  - The Host header must be a loopback name, which defeats DNS-rebinding
 *    attacks (a public hostname resolving to 127.0.0.1).
 *  - State-changing API requests must come from the dashboard itself: a
 *    cross-site page cannot POST into the local database.
 */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function proxy(request: NextRequest) {
  const host = request.headers.get('host') ?? '';
  if (!LOOPBACK.test(host)) {
    return new NextResponse('OpenPulse only answers on 127.0.0.1 / localhost', { status: 403 });
  }
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (mutating && request.nextUrl.pathname.startsWith('/api/')) {
    const site = request.headers.get('sec-fetch-site');
    const origin = request.headers.get('origin');
    if (site && site !== 'same-origin' && site !== 'none') {
      return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
    }
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = '';
      }
      if (originHost !== host) return NextResponse.json({ error: 'Cross-origin request refused' }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
