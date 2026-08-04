import React from 'react';
import { Project } from '../types';
import { SpotlightCard } from './SpotlightCard';
import { motion } from 'motion/react';
import { FolderGit2, BookOpen } from 'lucide-react';
import { WorkspaceToggleButton } from './ui/WorkspaceToggleButton';

interface BentoGridProps {
  projects: Project[];
  activeProject: Project | null;
  onSelect: (p: Project) => void;
  workspaceProjects: Project[];
  addToWorkspace: (p: Project) => void;
  removeFromWorkspace: (projectId: string) => void;
}

export const BentoGrid = ({ projects, activeProject, onSelect, workspaceProjects, addToWorkspace, removeFromWorkspace }: BentoGridProps) => {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {projects.map((project, i) => (
        <motion.div
          key={project.id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.1 }}
        >
          <SpotlightCard 
            active={activeProject?.id === project.id}
            onClick={() => onSelect(project)}
            className="p-6 h-full flex flex-col"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-[#00d4a3]/10 rounded-lg">
                <FolderGit2 className="text-[#00d4a3]" size={24} />
              </div>
               <h3 className="text-lg font-bold text-fg-strong flex-1">{project.name}</h3>
               <WorkspaceToggleButton
                 inWorkspace={workspaceProjects.some(p => p.id === project.id)}
                 onAdd={() => addToWorkspace(project)}
                 onRemove={() => removeFromWorkspace(project.id)}
                 size={14}
                 className="p-1"
               />
            </div>
            
            <p className="text-xs text-fg-dim font-mono truncate mb-4" title={project.path}>
              {project.path}
            </p>
            
            <div className="mt-auto pt-4 flex items-center gap-4 text-xs text-fg-dim">
              <span className="flex items-center gap-1">
                <BookOpen size={14} />
                {project.contextFiles?.length || 0} Docs
              </span>
              <span>
                {project.config?.entries?.length || 0} Triggers
              </span>
            </div>
          </SpotlightCard>
        </motion.div>
      ))}
    </div>
  );
};
