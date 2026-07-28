import React from 'react';
import { cn } from '../../lib/utils';
import { Sparkles } from 'lucide-react';

interface DisplayCardProps {
  className?: string;
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  date?: string;
  iconClassName?: string;
  titleClassName?: string;
}

function DisplayCard({ className, icon = <Sparkles className="size-4 text-blue-300" />, title = 'Featured', description = 'Discover amazing content', date = 'Just now', iconClassName = 'text-blue-500', titleClassName = 'text-blue-500' }: DisplayCardProps) {
  return (
    <div className={cn(
      'relative flex h-28 w-full skew-y-1 select-none flex-col justify-between rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm px-4 py-3 transition-all duration-700 after:absolute after:-right-1 after:top-[-5%] after:h-[110%] after:w-[20rem] after:bg-gradient-to-l after:from-[#0a0c10] after:to-transparent after:content-[""] hover:border-white/20 hover:bg-white/10 [&>*]:flex [&>*]:items-center [&>*]:gap-2',
      className
    )}>
      <div>
        <span className="relative inline-block rounded-full bg-[#3d6bff]/20 p-1">{icon}</span>
        <p className={cn('text-sm font-medium', titleClassName)}>{title}</p>
      </div>
      <p className="whitespace-nowrap text-xs text-gray-300">{description}</p>
      <p className="text-[10px] text-gray-600">{date}</p>
    </div>
  );
}

interface DisplayCardsProps {
  cards?: DisplayCardProps[];
}

export default function DisplayCards({ cards }: DisplayCardsProps) {
  const defaultCards = [
    { className: '[grid-area:stack] hover:-translate-y-2 before:absolute before:w-[100%] before:outline-1 before:rounded-xl before:outline-white/10 before:h-[100%] before:content-[""] before:bg-blend-overlay before:bg-[#0a0c10]/50 grayscale-[100%] hover:before:opacity-0 before:transition-opacity before:duration-700 hover:grayscale-0 before:left-0 before:top-0',
      icon: <Sparkles className="size-4 text-[#3d6bff]" />, title: 'CU Bet', description: 'Football simulation & sportsbook', date: 'Active', titleClassName: 'text-[#3d6bff]' },
    { className: '[grid-area:stack] translate-x-8 translate-y-3 hover:-translate-y-1 before:absolute before:w-[100%] before:outline-1 before:rounded-xl before:outline-white/10 before:h-[100%] before:content-[""] before:bg-blend-overlay before:bg-[#0a0c10]/50 grayscale-[100%] hover:before:opacity-0 before:transition-opacity before:duration-700 hover:grayscale-0 before:left-0 before:top-0',
      icon: <Sparkles className="size-4 text-[#00d4a3]" />, title: 'StudyFlash', description: 'Spaced-repetition flashcard PWA', date: 'Active', titleClassName: 'text-[#00d4a3]' },
    { className: '[grid-area:stack] translate-x-16 translate-y-6 hover:translate-y-1',
      icon: <Sparkles className="size-4 text-[#6366f1]" />, title: 'Dream Kick', description: 'Soccer prediction platform', date: 'Active', titleClassName: 'text-[#6366f1]' },
  ];

  return (
    <div className="grid [grid-template-areas:\'stack\'] place-items-center opacity-100 animate-in fade-in-0 duration-700">
      {(cards || defaultCards).map((cardProps, index) => (
        <DisplayCard key={index} {...cardProps} />
      ))}
    </div>
  );
}
