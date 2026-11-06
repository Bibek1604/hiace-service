import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export const money = (n: number) => `Rs. ${n.toLocaleString('en-NP')}`;
/** Route durations are stored as whole minutes so scheduling stays precise; show hours to staff and passengers. */
export const travelHours = (minutes: number) => {
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
};
export const nepalTime = (d: string | Date) =>
  new Date(d).toLocaleTimeString('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: '2-digit',
    minute: '2-digit',
  });
