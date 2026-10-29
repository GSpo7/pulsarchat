import styles from "../App.module.css";

export default function Legal({ onBack }) {
  return (
    <main className={styles.legalWrap}>
      <div className={styles.legalInner}>
        <div className={styles.legalHeader}>
          <button className={styles.backBtn} onClick={onBack} title="back">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M10 2L4 8l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className={styles.legalHeaderTitle}>Terms &amp; Privacy</span>
        </div>

        <div className={styles.legalContent}>
          <section className={styles.legalSection}>
            <h2 className={styles.legalSectionTitle}>Terms of Service</h2>
            <p>pulsarchat is provided as-is, without warranty of any kind, express or implied. Your use of the service is at your own risk.</p>
            <p>Users must not use pulsarchat for any illegal purposes, including but not limited to harassment, distribution of illegal content, or violation of applicable laws.</p>
            <p>We reserve the right to terminate access to the service at any time, for any reason, without notice.</p>
            <p>We accept no liability for damages or data loss arising from use of this service. In no event shall we be liable for any indirect, incidental, special, or consequential damages.</p>
            <p>Ghost-mode messages are ephemeral by design and cannot be recovered once a session ends. Messages in permanent rooms are kept (in encrypted form) on our server until the operator removes them, but if you lose the room code they cannot be recovered by anyone. Do not rely on pulsarchat as your only copy of important information.</p>
            <p>Anyone who knows a permanent room&apos;s code can read and write in that room. Choose a long, random code and share it only with people you trust.</p>
            <p>To the maximum extent permitted by applicable law, our total liability for any claims relating to this service is limited to zero, as the service is provided free of charge.</p>
          </section>

          <section className={styles.legalSection}>
            <h2 className={styles.legalSectionTitle}>Privacy Policy</h2>
            <p>There are no accounts, no sign-ups, and no user profiles. We do not ask for your name, email, or phone number.</p>
            <p>In ghost mode and saved chats, messages are end-to-end encrypted and travel directly between devices. They are never stored on a server.</p>
            <p>In permanent rooms, messages are end-to-end encrypted in your browser before they are sent. The server stores the encrypted message, a timestamp, its size, and a random per-device, per-room identifier. It does not receive your room code or any readable message text, names, or images, and it cannot decrypt them. Permanent-room data is not deleted automatically.</p>
            <p>Like any website, the infrastructure that delivers this site (including our network provider, Cloudflare) may process technical data such as IP addresses to operate and protect the service. The application does not record IP addresses alongside messages.</p>
            <p>This site does not add analytics or advertising trackers of its own.</p>
            <p>The signaling server sees only temporary connection metadata (peer IDs) required to establish a WebRTC connection. This metadata is not stored and is discarded immediately after the connection is established.</p>
            <p>No data is shared with third parties. We do not sell, rent, or otherwise disclose your information to anyone.</p>
            <p>Because permanent-room messages are encrypted with a key we never hold, we cannot identify or read the content of any room. If you want a room&apos;s stored data removed, contact the operator with the room code so that it can be located and deleted.</p>
          </section>
        </div>

        <div className={styles.footer}>
          pulsarchat &middot; made by //tedDev
        </div>
      </div>
    </main>
  );
}
