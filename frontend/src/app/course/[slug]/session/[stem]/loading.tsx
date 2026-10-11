import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main style={{ display: "grid", gap: 16, paddingTop: 20 }}>
      <Skeleton h={26} w={240} />
      <Skeleton h={76} radius={14} />
      <Skeleton h={220} />
    </main>
  );
}
