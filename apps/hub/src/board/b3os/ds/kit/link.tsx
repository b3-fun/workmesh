// One link for every kit component that takes an href (Figure, Attention, Note, RowCard, ResourceCard, the page
// header's back link): an in-app path goes through wouter's Link, so the router's base applies (/limits is /app/limits
// in the console; a plain <a> left the app for the site's /limits: Home+shell, PR #66); an external URL (a scheme or
// //host) stays a plain <a> that opens without handing the page its opener.
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "wouter";

/** An href that leaves the app: a scheme (https:, mailto:) or a protocol-relative //host. */
export function isExternalHref(href: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

export function KitLink({
  href,
  children,
  ...rest
}: { href: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  if (isExternalHref(href))
    return (
      <a href={href} rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}
