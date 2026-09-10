"use client";

import Link from "next/link";

/** Course link that doesn't toggle the surrounding <details> when clicked. */
export default function CourseLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} onClick={(e) => e.stopPropagation()}>
      <strong>{label}</strong>
    </Link>
  );
}
