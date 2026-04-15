export default function StatusBar({ connected, status }) {
  return (
    <div className="status-bar">
      <span className={`status-dot ${connected ? 'status-dot--live' : 'status-dot--dead'}`} />
      <span className="status-text">{status}</span>
    </div>
  );
}
