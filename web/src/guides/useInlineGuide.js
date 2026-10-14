import { createElement, useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth';
import TutorialTour from '../components/TutorialTour';
import { hasSeenGuide, markGuideSeen } from './index';

// A guide for something that is NOT a route — an editor or game that opens over
// a page — so guides/index.js's URL lookup cannot find it. The component calls
// this with its own guide and renders `element` once:
//
//   const guide = useInlineGuide(editorGuide, { ready: !loading });
//   ... <button onClick={guide.start}>?</button> ... {guide.element}
//
// It opens by itself the first time this user sees the thing (same per-browser
// "seen" list as the page guides), and `start()` replays it any time. `ready`
// holds the auto-start back until the controls the guide points at exist.
export default function useInlineGuide(guide, { autoStart = true, ready = true, delay = 900 } = {}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!autoStart || !ready || !guide?.steps?.length || !user) return undefined;
    if (hasSeenGuide(user.id, guide.key)) return undefined;
    const t = setTimeout(() => setOpen(true), delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide?.key, user?.id, autoStart, ready]);

  const finish = useCallback(() => {
    setOpen(false);
    if (guide && user) markGuideSeen(user.id, guide.key);
  }, [guide, user]);

  const start = useCallback(() => setOpen(true), []);
  const element = createElement(TutorialTour, { open, onFinish: finish, guideSteps: guide?.steps });
  return { start, open, element };
}
