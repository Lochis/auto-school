import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main style={{ display: "grid", gap: 16, paddingTop: 20 }}>
      <Skeleton h={30} w={200} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} h={140} />
        ))}
      </div>
    </main>
  );
}
