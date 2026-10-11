import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main style={{ display: "grid", gap: 16, paddingTop: 20 }}>
      <Skeleton h={30} w={260} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} h={88} />
        ))}
      </div>
      <Skeleton h={240} />
    </main>
  );
}
