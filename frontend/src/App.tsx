import { useState, useEffect, useRef, useMemo } from 'react';
import {
  AppBar,
  Box,
  Container,
  CssBaseline,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Toolbar,
  Typography,
  Button,
  TextField,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Tooltip,
  Avatar,
  Divider,
  Switch,
  Badge,
  Popover,
  LinearProgress,
} from '@mui/material';
import { Delete, Download, Bento, Settings, Brightness4, Brightness7, Add, Close } from '@mui/icons-material';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const drawerWidth = 280;

interface S3Bucket {
  Name: string;
}
interface S3Object {
  Key: string;
  Size: number;
  LastModified?: string;
  IsFolder?: boolean;
}

interface RegionConfig {
  name: string;
  region: string;
  access_key: string;
  secret_key: string;
  endpoint?: string;
}

interface Task {
  id: string;
  label: string;
  filename?: string;
  total?: number;
  loaded: number;
  start: number; // ms
  status: 'running' | 'done' | 'error';
}

function App() {
  const [apiUrl, setApiUrl] = useState('');
  const [buckets, setBuckets] = useState<S3Bucket[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [uploadPrefix, setUploadPrefix] = useState('');
  const [prefix, setPrefix] = useState('');
  const [openCreateBucketDialog, setOpenCreateBucketDialog] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [confirmDialogTitle, setConfirmDialogTitle] = useState('');
  const [confirmDialogMessage, setConfirmDialogMessage] = useState('');
  const [confirmAction, setConfirmAction] = useState<() => void>(() => {});

  const [regions, setRegions] = useState<RegionConfig[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('dark');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksAnchor, setTasksAnchor] = useState<HTMLElement | null>(null);
  const abortControllers = useRef<Record<string, AbortController>>({});

  const openConfirmDialog = (title: string, message: string, action: () => void) => {
    setConfirmDialogTitle(title);
    setConfirmDialogMessage(message);
    setConfirmAction(() => action);
    setConfirmDialogOpen(true);
  };

  const showErrorDialog = (message: string) => {
    setErrorMessage(message);
    setErrorDialogOpen(true);
  };

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch('/config.json');
        const config = await response.json();
        setApiUrl(config.apiHost);
      } catch (error) {
        showErrorDialog('Error fetching config: ' + error);
      }
    };

    fetchConfig();
  }, []);

  useEffect(() => {
    const init = async () => {
      if (apiUrl) {
        await fetchRegions();
        await fetchBuckets();
      }
    };
    init();
  }, [apiUrl]);

  const uploadFolderInputRef = useRef<HTMLInputElement>(null);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const bucketNameInputRef = useRef<HTMLInputElement>(null);

  const fetchRegions = async () => {
    try {
      const res = await fetch(`${apiUrl}/regions`);
      const data = await res.json();
      setRegions(data || []);
      if (data && data.length > 0 && !selectedRegion) {
        setSelectedRegion(data[0].name);
      }
    } catch (err) {
      showErrorDialog('Failed to fetch regions: ' + err);
    }
  };

  const fetchBuckets = async () => {
    try {
      const regionParam = selectedRegion ? `?region=${encodeURIComponent(selectedRegion)}` : '';
      const response = await fetch(`${apiUrl}/buckets${regionParam}`);
      if (!response.ok) {
        throw new Error('Failed to fetch buckets');
      }
      const data = await response.json();
      setBuckets(data || []);
    } catch (error) {
      console.error('Error fetching buckets:', error);
      showErrorDialog('Error fetching buckets. Is the backend running?');
    }
  };

  const fetchObjects = async (bucketName: string, currentPrefix: string) => {
    if (!apiUrl) return;
    try {
      const regionParam = selectedRegion ? `&region=${encodeURIComponent(selectedRegion)}` : '';
      const response = await fetch(
        `${apiUrl}/buckets/${bucketName}/objects?prefix=${currentPrefix}${regionParam}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch objects');
      }
      const data = await response.json();
      setObjects(data || []);

      // schedule background polling for folder stats (do not block UI)
      (data || []).forEach((item: any) => {
        if (item.IsFolder) {
          // if folder already has Size/LastModified, skip
          if (item.Size != null && item.LastModified) return;
          pollPrefixStat(bucketName, item.Key, 0);
        }
      });
    } catch (error) {
      showErrorDialog('Error fetching objects: ' + error);
    }
  };

  // poll prefix stats endpoint until ready or max attempts
  const pollPrefixStat = async (bucketName: string, prefixKey: string, attempt: number) => {
    if (!apiUrl) return;
    const maxAttempts = 30;
    try {
      const res = await fetch(`${apiUrl}/prefix-stats?bucket=${encodeURIComponent(bucketName)}&prefix=${encodeURIComponent(prefixKey)}&region=${encodeURIComponent(selectedRegion)}`);
      if (!res.ok) return;
      const js = await res.json();
      if (js.ready) {
        // update objects state with stats
        setObjects(prev => prev.map(o => o.Key === prefixKey ? { ...o, Size: js.size, LastModified: js.lastModified } : o));
        return;
      }
      if (attempt < maxAttempts) {
        setTimeout(() => pollPrefixStat(bucketName, prefixKey, attempt + 1), 1000);
      }
    } catch (err) {
      // ignore polling errors silently
    }
  };

  const openTasks = (e: React.MouseEvent<HTMLElement>) => setTasksAnchor(e.currentTarget);
  const closeTasks = () => setTasksAnchor(null);
  const runningCount = tasks.filter(t => t.status === 'running').length;

  const addTask = (label: string, filename?: string, total?: number) => {
    const id = String(Date.now()) + Math.random().toString(36).slice(2,8);
    const t: Task = { id, label, filename, total, loaded: 0, start: Date.now(), status: 'running' };
    setTasks(prev => [t, ...prev]);
    // create and store an AbortController for this task
    try {
      const controller = new AbortController();
      abortControllers.current[id] = controller;
    } catch (err) {
      // ignore
    }
    return id;
  };

  const updateTask = (id: string, loaded: number, total?: number, status?: Task['status']) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, loaded, total: total ?? t.total, status: status ?? t.status } : t));
  };

  const finishTask = (id: string, status: Task['status'] = 'done') => {
    updateTask(id, tasks.find(t=>t.id===id)?.loaded ?? 0, tasks.find(t=>t.id===id)?.total, status);
    // optionally remove after a delay
    // cleanup abort controller
    if (abortControllers.current[id]) {
      delete abortControllers.current[id];
    }
    setTimeout(() => setTasks(prev => prev.filter(t => t.id !== id)), 5000);
  };

  const cancelTask = (id: string) => {
    const controller = abortControllers.current[id];
    if (controller) {
      controller.abort();
      delete abortControllers.current[id];
    }
    // mark task as error/canceled
    updateTask(id, tasks.find(t=>t.id===id)?.loaded ?? 0, tasks.find(t=>t.id===id)?.total, 'error');
    // remove after short delay
    setTimeout(() => setTasks(prev => prev.filter(t => t.id !== id)), 3000);
  };

  useEffect(() => {
    if (selectedBucket) {
      fetchObjects(selectedBucket, prefix);
    }
  }, [selectedBucket, prefix, selectedRegion]);

  useEffect(() => {
    // refetch buckets when selectedRegion changes
    if (selectedRegion) fetchBuckets();
  }, [selectedRegion]);

  const handleBucketSelect = (bucketName: string) => {
    // clear current objects immediately so UI doesn't show previous bucket contents
    setObjects([]);
    setSelectedBucket(bucketName);
    setPrefix('');
  };

  const handleDelete = async (key: string) => {
    if (!selectedBucket || !apiUrl) return;
    openConfirmDialog(
      'Delete Object',
      `Are you sure you want to delete ${key}?`,
      async () => {
        try {
          const safeKey = encodeURIComponent(key).replace(/%2F/g, '/');
          const response = await fetch(
            `${apiUrl}/buckets/${selectedBucket}/objects/${safeKey}?region=${encodeURIComponent(selectedRegion)}`,
            { method: 'DELETE' }
          );
          if (!response.ok) {
            throw new Error('Failed to delete object');
          }
          setObjects((prevObjects) =>
            prevObjects.filter((obj) => obj.Key !== key)
          );
        } catch (error) {
          showErrorDialog('Error deleting object: ' + error);
        }
      }
    );
  };

  const handleDeleteFolder = async (folderKey: string) => {
    if (!selectedBucket || !apiUrl) return;
    openConfirmDialog(
      'Delete Folder',
      `Are you sure you want to delete the folder ${folderKey} and all its contents?`,
      async () => {
        try {
          const safePrefix = encodeURIComponent(folderKey).replace(/%2F/g, '/');
          const response = await fetch(
            `${apiUrl}/buckets/${selectedBucket}/folders/${safePrefix}?region=${encodeURIComponent(selectedRegion)}`,
            { method: "DELETE" }
          );

          if (!response.ok) {
            throw new Error("Failed to delete folder");
          }

          fetchObjects(selectedBucket, prefix);
        } catch (error) {
          showErrorDialog("Error deleting folder: " + error);
        }
      }
    );
  };

  const handleDownloadFolder = async (key: string) => {
    if (!selectedBucket || !apiUrl) return;
    try {
      const safePrefix = encodeURIComponent(key).replace(/%2F/g, '/');
      const url = `${apiUrl}/buckets/${selectedBucket}/folders/${safePrefix}?download=true&region=${encodeURIComponent(selectedRegion)}`;
      const taskId = addTask(`Download ${key}`, key + '.zip');
      await downloadWithProgress(url, key + '.zip', taskId);
    } catch (error) {
      showErrorDialog('Error downloading object: ' + error);
    }
  };

  const handleDownload = async (key: string) => {
    if (!selectedBucket || !apiUrl) return;
    try {
      const safeKey = encodeURIComponent(key).replace(/%2F/g, '/');
      const url = `${apiUrl}/buckets/${selectedBucket}/objects/${safeKey}?region=${encodeURIComponent(selectedRegion)}`;
      const taskId = addTask(`Download ${key}`, key);
      await downloadWithProgress(url, key, taskId);
    } catch (error) {
      showErrorDialog('Error downloading object: ' + error);
    }
  };

  // streaming download helper with progress reporting
  async function downloadWithProgress(url: string, filename: string, taskId: string) {
    try {
      const controller = abortControllers.current[taskId];
      const signal = controller ? controller.signal : undefined;
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error('Download failed');
      const contentLength = Number(resp.headers.get('content-length') || '0');
      if (contentLength) updateTask(taskId, 0, contentLength);

      const reader = resp.body?.getReader();
      if (!reader) throw new Error('Readable stream not supported');

      const chunks: Uint8Array[] = [];
      let received = 0;
      const start = Date.now();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          updateTask(taskId, received, contentLength || undefined);
        }
      }

      const blob = new Blob(chunks);
      const urlBlob = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = urlBlob;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(urlBlob);
      finishTask(taskId, 'done');
    } catch (err: any) {
      // If aborted, mark as error/canceled; otherwise show error
      if (err && err.name === 'AbortError') {
        updateTask(taskId, tasks.find(t=>t.id===taskId)?.loaded ?? 0, tasks.find(t=>t.id===taskId)?.total, 'error');
      } else {
        updateTask(taskId, tasks.find(t=>t.id===taskId)?.loaded ?? 0, tasks.find(t=>t.id===taskId)?.total, 'error');
        throw err;
      }
    } finally {
      // cleanup abort controller
      if (abortControllers.current[taskId]) delete abortControllers.current[taskId];
    }
  }

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedBucket || !apiUrl) return;
    if (!selectedRegion) {
      showErrorDialog('Please select a region before uploading');
      return;
    }
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('prefix', (prefix + uploadPrefix).replace(/^\/+/, ''));

    try {
      const response = await fetch(`${apiUrl}/buckets/${selectedBucket}/objects?region=${encodeURIComponent(selectedRegion)}`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const txt = await response.text().catch(() => 'Failed to upload file');
        throw new Error(txt || `Failed to upload file (status ${response.status})`);
      }
      fetchObjects(selectedBucket, prefix);
      if (uploadFileInputRef.current) {
        uploadFileInputRef.current.value = '';
      }
    } catch (error) {
      showErrorDialog('Error uploading object: ' + (error instanceof Error ? error.message : String(error)));
    }
  };

  const handlePrefixClick = (newPrefix: string) => {
    setPrefix(newPrefix);
  };

  const handleCreateBucket = async () => {
    if (!apiUrl) return;
    if (!selectedRegion) {
      showErrorDialog('Please select a region before creating a bucket');
      return;
    }
    try {
      const response = await fetch(`${apiUrl}/buckets?region=${encodeURIComponent(selectedRegion)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bucketName: newBucketName }),
      });
      if (!response.ok) {
        const txt = await response.text().catch(() => 'Failed to create bucket');
        throw new Error(txt || `Failed to create bucket (status ${response.status})`);
      }
      const bucketName = newBucketName;
      setNewBucketName('');
      setOpenCreateBucketDialog(false);
      await fetchBuckets();
      handleBucketSelect(bucketName);
    } catch (error) {
      showErrorDialog('Error creating bucket: ' + (error instanceof Error ? error.message : String(error)));
    }
  };

  const handleUploadFolder = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedBucket || !apiUrl) return;
    if (!selectedRegion) {
      showErrorDialog('Please select a region before uploading');
      return;
    }
    const files = event.target.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      const relativePath = (file as any).webkitRelativePath;
      const lastSlashIndex = relativePath.lastIndexOf('/');
      const prefixPath = lastSlashIndex === -1 ? '' : relativePath.substring(0, lastSlashIndex);

      formData.append('file', file);
      formData.append('prefix', (prefix + '/' + uploadPrefix + '/' + prefixPath).replace(/^\/+/, ''));

      try {
        const response = await fetch(`${apiUrl}/buckets/${selectedBucket}/objects?region=${encodeURIComponent(selectedRegion)}`, {
          method: 'POST',
          body: formData,
        });
        if (!response.ok) {
          const txt = await response.text().catch(() => 'Failed to upload file');
          throw new Error(txt || `Failed to upload file (status ${response.status})`);
        }
      } catch (error) {
        showErrorDialog('Error uploading object: ' + error);
      }
    }
    fetchObjects(selectedBucket, prefix);
    if (uploadFolderInputRef.current) {
      uploadFolderInputRef.current.value = '';
    }
  };

  const handleDeleteBucket = async (bucketName: string) => {
    if (!apiUrl) return;
    openConfirmDialog(
      'Delete Bucket',
      `Are you sure you want to delete bucket ${bucketName}?`,
      async () => {
        try {
          const response = await fetch(`${apiUrl}/buckets/${bucketName}?region=${encodeURIComponent(selectedRegion)}`, {
            method: 'DELETE',
          });
          if (!response.ok) {
            throw new Error('Failed to delete bucket');
          }
          fetchBuckets();
          setSelectedBucket(null);
          setObjects([]);
        } catch (error) {
          showErrorDialog('Error deleting bucket: ' + error);
        }
      }
    );
  };

  const normalized = objects.map((obj) => ({ ...obj, Key: obj.Key.replace(/^\/+/, '') }));
  const folders = normalized.filter((obj) => obj.IsFolder === true).filter((obj) => obj.Key !== prefix);
  const files = normalized.filter((obj) => !obj.IsFolder);

  function formatBytes(bytes?: number) {
    if (bytes == null || isNaN(bytes)) return '-';
    if (bytes === 0) return '0 B';
    const units = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const v = bytes / Math.pow(1024, i);
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`;
  }

  const muiTheme = useMemo(() => createTheme({ palette: { mode: themeMode } }), [themeMode]);

  return (
    <ThemeProvider theme={muiTheme}>
    <Box sx={{ display: 'flex' }}>
      <CssBaseline />
      <AppBar
        position="fixed"
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}
      >
        <Toolbar>
          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
            S3 Admin
          </Typography>
            <FormControl sx={{ minWidth: 180, mr: 2 }} size="small">
            <InputLabel id="region-select-label">Region</InputLabel>
            <Select
              labelId="region-select-label"
              value={selectedRegion}
              label="Region"
              onChange={(e) => setSelectedRegion(e.target.value as string)}
            >
              {regions.map((r) => (
                <MenuItem key={r.name} value={r.name}>{r.name}</MenuItem>
              ))}
            </Select>
            </FormControl>
          <Tooltip title="Settings — manage regions" arrow>
            <IconButton color="inherit" onClick={() => setSettingsOpen(true)}>
              <Settings />
            </IconButton>
          </Tooltip>
          <Tooltip title={themeMode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'} arrow>
            <IconButton color="inherit" onClick={() => setThemeMode(themeMode === 'light' ? 'dark' : 'light')}>
              {themeMode === 'light' ? <Brightness4 /> : <Brightness7 />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Show running tasks" arrow>
            <IconButton color="inherit" onClick={openTasks} sx={{ ml: 1 }}>
              <Badge badgeContent={runningCount} color="secondary">
                <Download />
              </Badge>
            </IconButton>
          </Tooltip>
          <Tooltip title="Create a new bucket" arrow>
            <Button color="inherit" startIcon={<Add />} onClick={() => setOpenCreateBucketDialog(true)}>
              New Bucket
            </Button>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Popover
        open={Boolean(tasksAnchor)}
        anchorEl={tasksAnchor}
        onClose={closeTasks}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Box sx={{ width: 360, p: 2 }}>
          <Typography variant="subtitle1">Tasks</Typography>
          {tasks.length === 0 && <Typography variant="body2" color="text.secondary">No tasks</Typography>}
          {tasks.map(t => {
            const pct = t.total ? Math.round((t.loaded / t.total) * 100) : undefined;
            const elapsed = (Date.now() - t.start) / 1000;
            const speed = t.loaded / Math.max(elapsed, 1);
            const remaining = t.total && t.loaded < t.total ? Math.round((t.total - t.loaded) / Math.max(speed, 1)) : undefined;
            return (
              <Box key={t.id} sx={{ mt: 1 }}>
                <Typography variant="body2">{t.label} {t.filename ? `— ${t.filename}` : ''}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box sx={{ flex: 1 }}>
                    <LinearProgress variant={t.total ? 'determinate' : 'indeterminate'} value={pct ?? 0} />
                  </Box>
                  <Box sx={{ width: 56, textAlign: 'right' }}>
                    <Typography variant="caption">{pct != null ? `${pct}%` : t.status}</Typography>
                    {remaining != null && <Typography variant="caption" display="block">{remaining}s</Typography>}
                  </Box>
                  <Box>
                    {t.status === 'running' && (
                      <IconButton size="small" onClick={() => cancelTask(t.id)}>
                        <Close fontSize="small" />
                      </IconButton>
                    )}
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Popover>
      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: {
            width: drawerWidth,
            boxSizing: 'border-box',
            background: 'linear-gradient(180deg, rgba(63,81,181,0.12), rgba(0,0,0,0))',
          },
        }}
      >
        <Toolbar />
        <Box sx={{ overflow: 'auto', p: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
            <Avatar sx={{ bgcolor: 'primary.main', width: 48, height: 48 }}>
              <Bento />
            </Avatar>
            <Box>
              <Typography variant="subtitle1">Buckets</Typography>
              <Typography variant="caption" color="text.secondary">Choose a bucket to view objects</Typography>
            </Box>
          </Box>
          <Divider sx={{ mb: 1 }} />
          <List>
            {buckets.map((bucket) => (
              <ListItem key={bucket.Name} disablePadding sx={{ mb: 1, borderRadius: 1, '&:hover': { backgroundColor: 'action.hover' } }}>
                <Tooltip title={`Open bucket ${bucket.Name}`} placement="right" arrow>
                  <ListItemButton
                    selected={selectedBucket === bucket.Name}
                    onClick={() => handleBucketSelect(bucket.Name)}
                    sx={{ borderRadius: 1 }}
                  >
                    <ListItemIcon>
                      <Bento />
                    </ListItemIcon>
                    <ListItemText primary={bucket.Name} />
                  </ListItemButton>
                </Tooltip>
                <Tooltip title={`Delete bucket ${bucket.Name}`} arrow>
                  <IconButton onClick={() => handleDeleteBucket(bucket.Name)} size="small">
                    <Delete />
                  </IconButton>
                </Tooltip>
              </ListItem>
            ))}
          </List>
        </Box>
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
        <Toolbar />
        <Container>
          {selectedBucket && (
            <>
              <Typography variant="h4" gutterBottom>
                {selectedBucket}
              </Typography>
              <Box sx={{ mb: 2 }}>
                <Typography variant="body1">
                  <Button onClick={() => handlePrefixClick('')}>root</Button> / 
                  {prefix
                    .split('/')
                    .filter((p) => p !== '')
                    .map((part, index) => (
                      <span key={index}>
                        <Button
                          onClick={() =>
                            handlePrefixClick(
                              prefix
                                .split('/')
                                .slice(0, index + 1)
                                .join('/') + '/'
                            )
                          }
                        >
                          {part}
                        </Button>
                        {' / '}
                      </span>
                    ))}
                </Typography>
              </Box>
              <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
                <TextField
                  label="Upload Prefix"
                  variant="outlined"
                  size="small"
                  value={uploadPrefix}
                  onChange={(e) => setUploadPrefix(e.target.value)}
                />
                <Tooltip title="Upload a single file to the selected bucket/prefix" arrow>
                  <Button variant="contained" component="label">
                    Upload File
                    <input
                      type="file"
                      hidden
                      onChange={handleUpload}
                      ref={uploadFileInputRef}
                    />
                  </Button>
                </Tooltip>
                <Tooltip title="Upload a folder (use browser folder upload)" arrow>
                  <Button variant="contained" component="label">
                    Upload Folder
                    <input
                      type="file"
                      hidden
                      onChange={handleUploadFolder}
                      {...{ webkitdirectory: "true" }}
                      ref={uploadFolderInputRef}
                    />
                  </Button>
                </Tooltip>
              </Box>
              <TableContainer component={Paper} sx={{ mt: 2 }}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Key</TableCell>
                      <TableCell align="right">Size (Bytes)</TableCell>
                      <TableCell align="right">Last Modified</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {folders.map((folder) => (
                      <TableRow
                          key={folder.Key}
                          hover
                          style={{ cursor: "pointer" }}
                          onClick={() => setPrefix(folder.Key)}
                        >
                          <TableCell
                            component="th"
                            scope="row"
                          >
                            {folder.Key.replace(prefix, "").replace("/", "")}
                          </TableCell>
                        <TableCell align="right">{formatBytes((folder as any).Size)}</TableCell>
                        <TableCell align="right">{(folder as any).LastModified ? new Date((folder as any).LastModified).toLocaleString() : '-'}</TableCell>
                        <TableCell align="right">
                          <Tooltip title="Download folder as ZIP" arrow>
                            <IconButton
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDownloadFolder(folder.Key);
                              }}
                            >
                              <Download />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete folder and all its contents" arrow>
                            <IconButton
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteFolder(folder.Key);
                              }}
                            >
                              <Delete />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                    {files.map((obj) => (
                      <TableRow key={obj.Key}>
                        <TableCell component="th" scope="row">
                          {obj.Key.replace(prefix, '')}
                        </TableCell>
                        <TableCell align="right">{formatBytes(obj.Size)}</TableCell>
                        <TableCell align="right">{obj.LastModified ? new Date(obj.LastModified).toLocaleString() : '-'}</TableCell>
                        <TableCell align="right">
                          <Tooltip title="Download object" arrow>
                            <IconButton onClick={() => handleDownload(obj.Key)}>
                              <Download />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete object" arrow>
                            <IconButton onClick={() => handleDelete(obj.Key)}>
                              <Delete />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
          {!selectedBucket && (
            <Typography>Select a bucket to view its objects.</Typography>
          )}
        </Container>
      </Box>

      {/* Create bucket dialog */}
      <Dialog
        open={openCreateBucketDialog}
        onClose={() => setOpenCreateBucketDialog(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleCreateBucket();
          }
        }}
        TransitionProps={{
          onEntered: () => {
            bucketNameInputRef.current?.focus();
          },
        }}
      >
        <DialogTitle>Create New Bucket</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Bucket Name"
            type="text"
            fullWidth
            variant="standard"
            value={newBucketName}
            onChange={(e) => setNewBucketName(e.target.value)}
            inputRef={bucketNameInputRef}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenCreateBucketDialog(false)} variant="text">Cancel</Button>
          <Button onClick={handleCreateBucket} variant="contained">Create</Button>
        </DialogActions>
      </Dialog>

      {/* Error dialog */}
      <Dialog open={errorDialogOpen} onClose={() => setErrorDialogOpen(false)}>
        <DialogTitle>Error</DialogTitle>
        <DialogContent>
          <Typography>{errorMessage}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setErrorDialogOpen(false)} variant="contained">Close</Button>
        </DialogActions>
      </Dialog>

      {/* Confirm dialog */}
      <Dialog
        open={confirmDialogOpen}
        onClose={() => setConfirmDialogOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            confirmAction();
            setConfirmDialogOpen(false);
          }
        }}
      >
        <DialogTitle>{confirmDialogTitle}</DialogTitle>
        <DialogContent>
          <Typography>{confirmDialogMessage}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDialogOpen(false)} variant="text">Cancel</Button>
          <Button
            onClick={() => {
              confirmAction();
              setConfirmDialogOpen(false);
            }}
            autoFocus
            variant="contained"
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>

      {/* Settings dialog for regions */}
      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Settings — Regions</DialogTitle>
        <DialogContent>
          <Typography variant="body2">Manage S3 regions/endpoints available in the UI.</Typography>
          <Box sx={{ mt: 2 }}>
            {regions.map((r) => (
              <Box key={r.name} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography sx={{ flex: 1 }}>{r.name} — {r.region} {r.endpoint ? `(${r.endpoint})` : ''}</Typography>
                <Button size="small" color="error" onClick={async () => {
                  // delete region
                  await fetch(`${apiUrl}/regions/${encodeURIComponent(r.name)}`, { method: 'DELETE' });
                  await fetchRegions();
                }}>Delete</Button>
              </Box>
            ))}
          </Box>
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1">Add new region</Typography>
            <AddRegionForm apiUrl={apiUrl} onAdded={async () => { await fetchRegions(); }} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSettingsOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
    </ThemeProvider>
  );
}

function AddRegionForm({ apiUrl, onAdded }: { apiUrl: string; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [endpoint, setEndpoint] = useState('');

  const submit = async () => {
    if (!apiUrl) return;
    try {
      const body = { name, region, access_key: accessKey, secret_key: secretKey, endpoint };
      const res = await fetch(`${apiUrl}/regions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('Failed to add region');
      setName(''); setRegion(''); setAccessKey(''); setSecretKey(''); setEndpoint('');
      onAdded();
    } catch (err) {
      console.error(err);
      alert('Failed to add region: ' + err);
    }
  };

  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} size="small" />
      <TextField label="Region" value={region} onChange={(e) => setRegion(e.target.value)} size="small" />
      <TextField label="Access Key" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} size="small" />
      <TextField label="Secret Key" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} size="small" />
      <TextField label="Endpoint (optional)" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} size="small" />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1 }}>
        <Button variant="contained" onClick={submit}>Add Region</Button>
      </Box>
    </Box>
  );
}

export default App;
