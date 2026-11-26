export { Logo } from './Logo';
export type { LogoProps, LogoVariant } from './Logo';
export { CellIcon, CELL_ICON_NAMES } from './CellIcon';
export type { CellIconProps, CellIconName } from './CellIcon';
export { SeverityBadge } from './SeverityBadge';
export type { SeverityBadgeProps, SeverityLevel } from './SeverityBadge';
export { StatusPill } from './StatusPill';
export type { StatusPillProps, StatusTone } from './StatusPill';
export { FacetSelect } from './FacetSelect';
export type { FacetSelectProps, FacetOption } from './FacetSelect';
export { FullLogo } from './FullLogo';
export type { FullLogoProps, FullLogoVariant, FullLogoScript } from './FullLogo';
export { Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';
export { IconButton } from './IconButton';
export type { IconButtonProps } from './IconButton';
export { AgentWorkbenchShell, AgentWorkbenchPhaseRail } from './AgentWorkbench';
export type {
  AgentWorkbenchShellProps,
  AgentWorkbenchTone,
  AgentWorkbenchPhaseItem,
  AgentWorkbenchPhaseStatus,
  AgentWorkbenchPhaseRailProps,
} from './AgentWorkbench';
// The detail kit — main column plus the sticky 360px rail. Four entities, one
// skeleton; the rail is a workflow, not a properties list.
export {
  DetailPageShell,
  RailLayout,
  InspectorSplit,
  clampPaneWidth,
  DetailHeader,
  DetailSection,
  DetailBackLink,
  DetailRailBlock,
  DetailRailField,
  DetailRailNote,
  DisclosurePanel,
  FactGrid,
  Fact,
  FigureLine,
  RecordInspector,
} from './detail';
export type {
  DetailPageShellProps,
  InspectorSplitProps,
  DetailHeaderProps,
  DetailSectionProps,
  DetailBackLinkProps,
  DisclosurePanelProps,
  DetailRailBlockProps,
  DetailRailFieldProps,
  DetailRailNoteProps,
  FactGridProps,
  FactProps,
  FigureLineProps,
  FigureLineItem,
  RecordInspectorProps,
  RecordInspectorTab,
} from './detail';

// The list kit — the one query bar, the one status strip, the one data table.
// Every list page composes these; none of them re-implements a list.
export {
  QueryBar,
  StatusTabs,
  RecordTable,
  StackList,
  NotificationList,
  PromptRail,
  ListEmptyState,
  ListSkeleton,
  ListPageShell,
  ListNotice,
  ListMeta,
  ListMetrics,
  ListPager,
  TabbedListShell,
  DashboardCell,
  DashboardGrid,
  IdentityBand,
  SectionPanel,
  SecretValue,
  ProviderPanel,
  DisclosureList,
  ToolCallRow,
  EventLedger,
  buildLedgerItems,
  ledgerOffsets,
  ledgerIndexAt,
} from './lists';
export type {
  QueryBarProps,
  StatusTabsProps,
  DashboardCellProps,
  DashboardGridProps,
  IdentityBandProps,
  IdentityBandStat,
  StackListProps,
  StackListRow,
  NotificationListItem,
  NotificationListProps,
  PromptRailItem,
  PromptRailProps,
  StatusTabItem,
  RecordTableProps,
  RecordTableColumn,
  RecordStripe,
  ListEmptyStateProps,
  ListSkeletonProps,
  ListPageShellProps,
  ListNoticeProps,
  ListMetaProps,
  ListMetricsProps,
  ListMetricItem,
  ListMetricSeverity,
  ListPagerProps,
  TabbedListShellProps,
  TabbedListSection,
  SectionPanelProps,
  SecretValueProps,
  ProviderPanelProps,
  ProviderFact,
  DisclosureListProps,
  DisclosureListItem,
  DisclosureDensity,
  ToolCallRowProps,
  ToolCallState,
  EventLedgerProps,
  EventLedgerRow,
} from './lists';
export { RunFindingList } from './RunFindingList';
export type { RunFindingListItem, RunFindingListProps } from './RunFindingList';
export { StatBreakdownCard } from './StatBreakdownCard';
export type { StatBreakdownCardProps, StatBreakdownItem, StatBreakdownHighlight } from './StatBreakdownCard';
export { PhaseTimeline } from './PhaseTimeline';
export type { PhaseTimelineProps, PhaseTimelineStep, PhaseTimelineStepState } from './PhaseTimeline';
export { Code } from './Code';
export type { CodeProps } from './Code';
export { Input } from './Input';
export type { InputProps } from './Input';
export { Textarea } from './Textarea';
export type { TextareaProps } from './Textarea';
export { Label } from './Label';
export type { LabelProps } from './Label';
export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';
export { ClauseCheckbox } from './ClauseCheckbox';
export type { ClauseCheckboxProps } from './ClauseCheckbox';
export { Switch } from './Switch';
export type { SwitchProps } from './Switch';
export { Badge } from './Badge';
export type { BadgeProps, BadgeStatus, BadgeVariant } from './Badge';
export { NativeSelect } from './NativeSelect';
export type { NativeSelectProps } from './NativeSelect';
export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton } from './Select';
export { Modal, ModalContent, ModalFooter } from './Modal';
export type { ModalProps } from './Modal';
export { Drawer } from './Drawer';
export type { DrawerProps, DrawerSize } from './Drawer';
export { Sheet, SheetPortal, SheetOverlay, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription } from './Sheet';
export { cn } from './cn';
export { severityTone, SEVERITY_ORDER } from './severity';
export { themeWipe, THEME_WIPE_MS } from './themeWipe';
export { FindingStatusBadge, RunStatusBadge, ExposureStateBadge, KevBadge, MatchCaveatBadge } from './status';
export type { SeverityKey, SeverityChannel } from './severity';

// Component exports
// Feedback
export { Avatar, AvatarImage, AvatarFallback, Progress, AlertDialog, EmptyState, NotificationDot, PendingNote, ErrorNotice, CellMeter, CellField, CelebrationOverlay, WorkingOverlay, LoadingScreen, useMinimumVisible, BootScreenProvider, useBootScreen } from './feedback';
export type { PendingNoteProps, ErrorNoticeProps, CellMeterProps, CellFieldProps, CellFieldMode, CelebrationOverlayProps, WorkingOverlayProps, LoadingScreenProps, BootScreenProviderProps } from './feedback';

// Navigation — the shell every service sits in
export { AppShell, AppRail, railUtilityClass, RAIL_COLLAPSED_WIDTH, RAIL_EXPANDED_WIDTH } from './navigation';
export type {
  AppShellProps,
  AppRailProps,
  AppRailItem,
  AppRailGroup,
  AppRailIdentity,
  AppRailAccount,
} from './navigation';

// Theme — one provider, one wipe, both selectors
export { ThemeProvider, useTheme } from './theme';
export type { Theme, ThemeContextValue } from './theme';


// Forms
export { Stepper, SegmentedControl } from './forms';
export type { StepperProps, SegmentedControlProps, SegmentedControlOption } from './forms';

// Layout
export { CornerFrame, ScrollArea, useFillHeight } from './layout';
export type { CornerFrameProps, ScrollAreaProps, FillHeightOptions } from './layout';

// Data Display
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Popover } from './data';

export {
  ChartFrame,
  ChartBand,
  ChartEmpty,
  ChartReadout,
  DonutChart,
  Sparkline,
  ActivityHeatmap,
  RankedBars,
  RadarChart,
  StackedBars,
  GaugeArc,
  MatrixHeatmap,
  ScatterMatrix,
  TimingLanes,
  TIMING_AXES,
  deriveTimingModel,
  spansInFocus,
  zoomTimingFocus,
} from './charts';
export type {
  ChartFrameProps,
  ChartBandProps,
  ChartEmptyProps,
  ChartReadoutProps,
  ChartReadoutRow,
  DonutChartProps,
  DonutSegment,
  SparklineProps,
  SparklineSeries,
  ActivityHeatmapProps,
  RankedBarsProps,
  RankedBarItem,
  RadarChartProps,
  RadarAxis,
  StackedBarsProps,
  StackedBarColumn,
  StackedBarSegment,
  GaugeArcProps,
  MatrixHeatmapProps,
  ScatterMatrixProps,
  ScatterPoint,
  TimingLanesProps,
  TimingAxis,
  TimingLane,
  TimingSpanInput,
  TimingModel,
  TimingFocus,
} from './charts';
