export interface NameProfile {
  name: string;
  title: string;
}

/** "Master Tobi" when a title is set, bare name when the title is empty or "none". */
export function formatUserName(profile: NameProfile): string {
  if (!profile.title || profile.title.toLowerCase() === 'none') {
    return profile.name;
  }
  return `${profile.title} ${profile.name}`;
}
