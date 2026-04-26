import { useEffect, useRef, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { CSSProperties } from "react";
import { useAppStore, type Project, type ProjectGroup } from "../store/appStore";
import { ProjectRow } from "./ProjectRow";
import { GroupHeader } from "./GroupHeader";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { ColorPicker } from "./ColorPicker";
import { SnippetsDialog } from "./SnippetsDialog";

type ProjectCtxState = {
  kind: "project";
  x: number;
  y: number;
  projectId: string;
};
type GroupCtxState = {
  kind: "group";
  x: number;
  y: number;
  groupId: string;
};
type CtxState = ProjectCtxState | GroupCtxState;

type ProjectListProps = {
  onAddProject: (groupId?: string | null) => void;
};

export function ProjectList({ onAddProject }: ProjectListProps) {
  const projects = useAppStore((s) => s.projects);
  const groups = useAppStore((s) => s.groups);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const tabs = useAppStore((s) => s.tabs);
  const openProject = useAppStore((s) => s.openProject);
  const updateProject = useAppStore((s) => s.updateProject);
  const removeProject = useAppStore((s) => s.removeProject);
  const reorderProjects = useAppStore((s) => s.reorderProjects);
  const reorderGroups = useAppStore((s) => s.reorderGroups);
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup);
  const toggleGroup = useAppStore((s) => s.toggleGroup);
  const renameGroup = useAppStore((s) => s.renameGroup);
  const removeGroup = useAppStore((s) => s.removeGroup);
  const externalRenamingProjectId = useAppStore((s) => s.renamingProjectId);
  const requestProjectRename = useAppStore((s) => s.requestProjectRename);
  const externalRenamingGroupId = useAppStore((s) => s.renamingGroupId);
  const requestGroupRename = useAppStore((s) => s.requestGroupRename);

  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [colorEditId, setColorEditId] = useState<string | null>(null);
  const [snippetsProjectId, setSnippetsProjectId] = useState<string | null>(
    null,
  );
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const colorEditProject: Project | undefined = colorEditId
    ? projects.find((p) => p.id === colorEditId)
    : undefined;

  useEffect(() => {
    if (externalRenamingProjectId) {
      setRenamingId(externalRenamingProjectId);
      requestProjectRename(null);
    }
  }, [externalRenamingProjectId, requestProjectRename]);

  useEffect(() => {
    if (externalRenamingGroupId) {
      setRenamingGroup(externalRenamingGroupId);
      requestGroupRename(null);
    }
  }, [externalRenamingGroupId, requestGroupRename]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const ungrouped = projects.filter((p) => p.groupId === null);
  const projectsByGroup = new Map<string, Project[]>();
  for (const g of groups) projectsByGroup.set(g.id, []);
  for (const p of projects) {
    if (p.groupId && projectsByGroup.has(p.groupId)) {
      projectsByGroup.get(p.groupId)!.push(p);
    }
  }

  function buildProjectMenu(projectId: string): MenuItem[] {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return [];
    const items: MenuItem[] = [
      {
        label: "Rename",
        onClick: () => setRenamingId(projectId),
      },
      {
        label: "Change color",
        onClick: () => setColorEditId(projectId),
      },
      {
        label: "Snippets…",
        onClick: () => setSnippetsProjectId(projectId),
      },
      {
        label: "Open in file explorer",
        onClick: async () => {
          try {
            await openPath(project.path);
          } catch (err) {
            await message(
              `Could not open ${project.path}:\n${String(err)}`,
              { kind: "error", title: "Open failed" },
            );
          }
        },
      },
    ];
    // Move-to-group entries (inline list). Hide options that equal the
    // project's current group so the menu doesn't offer a no-op.
    if (groups.length > 0 || project.groupId !== null) {
      if (project.groupId !== null) {
        items.push({
          label: "Move to: No group",
          onClick: () => void moveProjectToGroup(projectId, null),
        });
      }
      for (const g of groups) {
        if (g.id === project.groupId) continue;
        items.push({
          label: `Move to: ${g.name}`,
          onClick: () => void moveProjectToGroup(projectId, g.id),
        });
      }
    }
    items.push({
      label: "Remove",
      onClick: async () => {
        const openTabCount = tabs.filter(
          (t) => t.projectId === projectId,
        ).length;
        const tabLine =
          openTabCount > 0
            ? `\nThis will close ${openTabCount} open tab${openTabCount === 1 ? "" : "s"}.`
            : "";
        const ok = await ask(
          `Remove project "${project.name}"?${tabLine}`,
          { kind: "warning", title: "Remove project" },
        );
        if (ok) await removeProject(projectId);
      },
    });
    return items;
  }

  function buildGroupMenu(groupId: string): MenuItem[] {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return [];
    const idx = groups.findIndex((g) => g.id === groupId);
    const items: MenuItem[] = [
      {
        label: "Add project here",
        onClick: () => onAddProject(groupId),
      },
      {
        label: "Rename",
        onClick: () => setRenamingGroup(groupId),
      },
    ];
    if (idx > 0) {
      items.push({
        label: "Move up",
        onClick: () => void reorderGroups(groupId, groups[idx - 1].id),
      });
    }
    if (idx < groups.length - 1) {
      items.push({
        label: "Move down",
        onClick: () => void reorderGroups(groupId, groups[idx + 1].id),
      });
    }
    items.push({
      label: "Remove group",
      onClick: async () => {
        const projectsInGroup = projects.filter(
          (p) => p.groupId === groupId,
        ).length;
        const hint =
          projectsInGroup > 0
            ? `\n${projectsInGroup} project${projectsInGroup === 1 ? "" : "s"} will move to No group.`
            : "";
        const ok = await ask(
          `Remove group "${group.name}"?${hint}`,
          { kind: "warning", title: "Remove group" },
        );
        if (ok) await removeGroup(groupId);
      },
    });
    return items;
  }

  // Auto-expand a collapsed group when a dragged project hovers over its
  // header for more than 500 ms — then the user can drop inside it.
  const expandTimerRef = useRef<{
    groupId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  function cancelExpandTimer() {
    if (expandTimerRef.current) {
      clearTimeout(expandTimerRef.current.timer);
      expandTimerRef.current = null;
    }
  }

  function onDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    const activeId = String(active.id);
    // Only project drags trigger expansion — dragging a group header onto
    // another collapsed one isn't a "move into" semantic.
    if (activeId.startsWith("group-") || !over) {
      cancelExpandTimer();
      return;
    }
    const overId = String(over.id);
    if (!overId.startsWith("group-")) {
      cancelExpandTimer();
      return;
    }
    const groupId = overId.slice(6);
    const group = groups.find((g) => g.id === groupId);
    if (!group || !group.collapsed) {
      cancelExpandTimer();
      return;
    }
    // Same group still hovered — keep existing timer running.
    if (expandTimerRef.current?.groupId === groupId) return;
    cancelExpandTimer();
    expandTimerRef.current = {
      groupId,
      timer: setTimeout(() => {
        void toggleGroup(groupId);
        expandTimerRef.current = null;
      }, 500),
    };
  }

  function onDragEnd(event: DragEndEvent) {
    cancelExpandTimer();
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const activeIsGroup = activeId.startsWith("group-");
    const overIsGroup = overId.startsWith("group-");

    // Group <-> group drag: reorder groups.
    if (activeIsGroup && overIsGroup) {
      void reorderGroups(activeId.slice(6), overId.slice(6));
      return;
    }

    // Project dropped onto a group header: move project to that group.
    if (!activeIsGroup && overIsGroup) {
      void moveProjectToGroup(activeId, overId.slice(6));
      return;
    }

    // Project dropped onto another project.
    if (!activeIsGroup && !overIsGroup) {
      const activeProject = projects.find((p) => p.id === activeId);
      const overProject = projects.find((p) => p.id === overId);
      if (!activeProject || !overProject) return;
      if (activeProject.groupId !== overProject.groupId) {
        // Cross-group: reassign to the target's group. We don't try to
        // position precisely inside the target group — within-group order
        // can be fine-tuned with a second drag after the move.
        void moveProjectToGroup(activeId, overProject.groupId);
      } else {
        void reorderProjects(activeId, overId);
      }
    }
  }

  function renderProjectRow(p: Project) {
    const hasActivity = tabs.some(
      (t) => t.projectId === p.id && t.hasUnread,
    );
    return (
      <ProjectRow
        key={p.id}
        project={p}
        editing={renamingId === p.id}
        active={activeProjectId === p.id}
        hasActivity={hasActivity}
        onActivate={() => void openProject(p.id)}
        onContextMenu={(x, y) =>
          setCtx({ kind: "project", x, y, projectId: p.id })
        }
        onCommitRename={async (name) => {
          setRenamingId(null);
          await updateProject(p.id, { name });
        }}
        onCancelRename={() => setRenamingId(null)}
      />
    );
  }

  return (
    <>
      <div className="project-list">
        {projects.length === 0 && groups.length === 0 && (
          <div className="project-list__empty">
            No projects yet. Click + to add one.
          </div>
        )}

        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            cancelExpandTimer();
            setActiveDragId(null);
          }}
          measuring={{
            droppable: { strategy: MeasuringStrategy.Always },
          }}
        >
          {ungrouped.length > 0 && (
            <SortableContext
              items={ungrouped.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {ungrouped.map(renderProjectRow)}
            </SortableContext>
          )}

          {/* Outer SortableContext makes group headers themselves drag-to-
              reorder. Each group's projects live in their own nested
              SortableContext so within-group reorder uses a sibling ID set. */}
          <SortableContext
            items={groups.map((g) => `group-${g.id}`)}
            strategy={verticalListSortingStrategy}
          >
            {groups.map((group) => {
              const groupProjects = projectsByGroup.get(group.id) ?? [];
              return (
                <div key={group.id} className="project-group">
                  <GroupHeader
                    group={group}
                    projectCount={groupProjects.length}
                    editing={renamingGroup === group.id}
                    onToggle={() => void toggleGroup(group.id)}
                    onContextMenu={(x, y) =>
                      setCtx({ kind: "group", x, y, groupId: group.id })
                    }
                    onCommitRename={async (name) => {
                      setRenamingGroup(null);
                      await renameGroup(group.id, name);
                    }}
                    onCancelRename={() => setRenamingGroup(null)}
                  />
                  {!group.collapsed && (
                    <SortableContext
                      items={groupProjects.map((p) => p.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {groupProjects.map(renderProjectRow)}
                    </SortableContext>
                  )}
                </div>
              );
            })}
          </SortableContext>

          <DragOverlay dropAnimation={null}>
            {renderDragOverlay(activeDragId, projects, groups)}
          </DragOverlay>
        </DndContext>
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={
            ctx.kind === "project"
              ? buildProjectMenu(ctx.projectId)
              : buildGroupMenu(ctx.groupId)
          }
          onClose={() => setCtx(null)}
        />
      )}

      <Modal
        open={!!colorEditProject}
        onClose={() => setColorEditId(null)}
        title={
          colorEditProject ? `Color: ${colorEditProject.name}` : undefined
        }
      >
        {colorEditProject && (
          <ColorPicker
            value={colorEditProject.color}
            onChange={async (color) => {
              await updateProject(colorEditProject.id, { color });
            }}
          />
        )}
      </Modal>

      <SnippetsDialog
        projectId={snippetsProjectId}
        onClose={() => setSnippetsProjectId(null)}
      />
    </>
  );
}

/**
 * Build a floating clone of the active drag item. Used by `<DragOverlay>` so
 * the visual dragged item follows the cursor freely — without this,
 * cross-container drags would appear to "snap back" to the origin group
 * since dnd-kit's default is to animate the item inside its own
 * SortableContext.
 */
function renderDragOverlay(
  activeId: string | null,
  projects: Project[],
  groups: ProjectGroup[],
) {
  if (!activeId) return null;
  if (activeId.startsWith("group-")) {
    const group = groups.find((g) => g.id === activeId.slice(6));
    if (!group) return null;
    return (
      <div className="group-header group-header--dragging">
        <span
          className={`group-header__chevron ${
            group.collapsed ? "group-header__chevron--collapsed" : ""
          }`}
        >
          ▼
        </span>
        <span className="group-header__name">{group.name}</span>
      </div>
    );
  }
  const project = projects.find((p) => p.id === activeId);
  if (!project) return null;
  const style: CSSProperties = {
    "--project-color": project.color,
    cursor: "grabbing",
  } as CSSProperties;
  return (
    <div className="project-row" style={style}>
      <span className="project-row__indicator" aria-hidden />
      <span className="project-row__name">{project.name}</span>
    </div>
  );
}
