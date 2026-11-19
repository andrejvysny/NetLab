/** React access to the lab. Owned by the orchestrator. The UI only ever talks to LabApi. */
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { LabApi, LabState } from '../engine/labapi.ts';

const LabContext = createContext<LabApi | null>(null);
export const LabProvider = LabContext.Provider;

export function useLab(): LabApi {
  const lab = useContext(LabContext);
  if (!lab) throw new Error('LabProvider is missing');
  return lab;
}
/** Re-renders when the lab changes. getState() returns the same object until `rev` changes. */
export function useLabState(): LabState {
  const lab = useLab();
  return useSyncExternalStore(lab.subscribe, lab.getState, lab.getState);
}
