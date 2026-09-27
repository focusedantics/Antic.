export default function Develop({ Shell }: { Shell: React.ComponentType<{ left: React.ReactNode; center: React.ReactNode; right: React.ReactNode }> }) {
  return (
    <Shell
      left={null}
      center={
        <div className="empty-state">
          <h2>Develop</h2>
          <p>The Develop renderer is being built (Stage 2).</p>
        </div>
      }
      right={null}
    />
  );
}
