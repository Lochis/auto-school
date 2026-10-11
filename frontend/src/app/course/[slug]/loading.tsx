import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main style={{ display: "grid", gap: 16, paddingTop: 20 }}>
      <Skeleton h={30} w={320} />
      <Skeleton h={36} w={420} radius={999} />
      <Skeleton h={280} />
    </main>
  );
}
