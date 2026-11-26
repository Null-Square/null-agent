import { HeroWave } from '@modules/chat/ui/HeroWave';

/**
 * Agent home page.
 * Shared product entrypoint for Pentest, Compliance, and Code Review.
 */
export default function HomePage() {
  return (
    <HeroWave
      title="Null Ai."
      subtitle="Choose Pentest, Compliance, or Code Review to start the right security workflow."
      placeholder="Help me assess my"
      buttonText="Send Message"
      motionPreset="calm"
    />
  );
}
