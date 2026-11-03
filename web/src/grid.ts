import {
  CellStyleModule,
  ClientSideRowModelModule,
  GridStateModule,
  ModuleRegistry,
  NumberFilterModule,
  RowSelectionModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
  themeQuartz,
} from "ag-grid-community";
import {
  AiToolkitModule,
  CellSelectionModule,
  ColumnMenuModule,
  ContextMenuModule,
  IntegratedChartsModule,
  LicenseManager,
  RowGroupingModule,
  SetFilterModule,
} from "ag-grid-enterprise";
import { AgChartsEnterpriseModule } from "ag-charts-enterprise";

// Only the features the dashboard uses; registering everything ships a 5 MB bundle.
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  RowSelectionModule,
  TooltipModule,
  CellStyleModule,
  SetFilterModule,
  CellSelectionModule,
  ColumnMenuModule,
  ContextMenuModule,
  GridStateModule,
  RowGroupingModule,
  AiToolkitModule,
  IntegratedChartsModule.with(AgChartsEnterpriseModule),
  ...(import.meta.env.DEV ? [ValidationModule] : []),
]);

// Free trial key from ag-grid.com. Without it the grid still works but shows a watermark.
const key = import.meta.env.VITE_AG_GRID_LICENSE as string | undefined;
if (key) LicenseManager.setLicenseKey(key);

export const gridTheme = themeQuartz.withParams({
  accentColor: "#113a5c",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 13.5,
  headerFontWeight: 600,
  headerBackgroundColor: "#f5f7fa",
  borderColor: "#e3e8ef",
  rowHoverColor: "#f2f6fa",
  wrapperBorderRadius: 10,
  spacing: 7,
});
