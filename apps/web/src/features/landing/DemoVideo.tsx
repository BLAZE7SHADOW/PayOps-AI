import { Section } from './Section';

/**
 * The recorded walkthrough, hosted with the site. preload="none" plus a poster means a visitor
 * downloads nothing until they press play. Captions are burned into the video itself.
 */
export function DemoVideo() {
  return (
    <Section
      id="demo"
      title="See it work"
      lead="A 3-minute walkthrough of one case, from the mismatch to a checked fix, and a refund that waits for a manager."
    >
      <div className="overflow-hidden rounded-lg border border-rule bg-surface-sunk">
        <video
          controls
          playsInline
          preload="none"
          poster="/landing/demo-poster.jpg"
          width={1920}
          height={1080}
          className="block aspect-video h-auto w-full"
          aria-label="PayOps AI walkthrough, 3 minutes, narrated and captioned"
        >
          <source src="/landing/payops-demo.mp4" type="video/mp4" />
          Your browser cannot play this video.
        </video>
      </div>
      <p className="mt-3 max-w-[62ch] text-14 leading-[1.6] text-ink-2">
        Payments are simulated and the AI answers are replayed from recordings. The application, the rules, the database changes and the
        checks run for real.
      </p>
    </Section>
  );
}
