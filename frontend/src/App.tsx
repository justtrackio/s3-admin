import { useState, useEffect, useRef } from 'react';
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
} from '@mui/material';
import { Delete, Download, Bento } from '@mui/icons-material';

const drawerWidth = 240;

interface S3Bucket {
  Name: string;
}

interface S3Object {
  Key: string;
  Size: number;
  LastModified: string;
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
    const fetchInitialData = async () => {
        if (apiUrl) {
            await fetchBuckets();
        }
    };
    fetchInitialData();
  }, [apiUrl]);
  const uploadFolderInputRef = useRef<HTMLInputElement>(null);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const bucketNameInputRef = useRef<HTMLInputElement>(null);

  
    const fetchBuckets = async () => {
    try {
      const response = await fetch(`${apiUrl}/buckets`);
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
      const response = await fetch(
        `${apiUrl}/buckets/${bucketName}/objects?prefix=${currentPrefix}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch objects');
      }
      const data = await response.json();
      setObjects(data || []);
    } catch (error) {
      showErrorDialog('Error fetching objects: ' + error);
    }
  };

  

  useEffect(() => {
    if (selectedBucket) {
      fetchObjects(selectedBucket, prefix);
    }
  }, [selectedBucket, prefix]);

  const handleBucketSelect = (bucketName: string) => {
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
          const response = await fetch(
            `${apiUrl}/buckets/${selectedBucket}/objects/${key}`,
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
          const response = await fetch(
            `${apiUrl}/buckets/${selectedBucket}/folders/${folderKey}`,
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
      const response = await fetch(
        `${apiUrl}/buckets/${selectedBucket}/folders/${key}?download=true`
      );
      if (!response.ok) {
        throw new Error('Failed to download object');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', key + '.zip');
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
    } catch (error) {
      showErrorDialog('Error downloading object: ' + error);
    }
  };

  const handleDownload = async (key: string) => {
    if (!selectedBucket || !apiUrl) return;
    try {
      const response = await fetch(
        `${apiUrl}/buckets/${selectedBucket}/objects/${key}`
      );
      if (!response.ok) {
        throw new Error('Failed to download object');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', key);
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
    } catch (error) {
      showErrorDialog('Error downloading object: ' + error);
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedBucket || !apiUrl) return;
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('prefix', (prefix + uploadPrefix).replace(/^\/+/g, ''));

    try {
      const response = await fetch(`${apiUrl}/buckets/${selectedBucket}/objects`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        throw new Error('Failed to upload file');
      }
      fetchObjects(selectedBucket, prefix);
      if (uploadFileInputRef.current) {
        uploadFileInputRef.current.value = '';
      }
    } catch (error) {
      showErrorDialog('Error uploading object: ' + error);
    }
  };

  const handlePrefixClick = (newPrefix: string) => {
    setPrefix(newPrefix);
  };

  const handleCreateBucket = async () => {
    if (!apiUrl) return;
    try {
      const response = await fetch(`${apiUrl}/buckets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bucketName: newBucketName }),
      });
      if (!response.ok) {
        throw new Error('Failed to create bucket');
      }
      const bucketName = newBucketName;
      setNewBucketName('');
      setOpenCreateBucketDialog(false);
      await fetchBuckets();
      handleBucketSelect(bucketName);
    } catch (error) {
      showErrorDialog('Error creating bucket: ' + error);
    }
  };

  const handleUploadFolder = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedBucket || !apiUrl) return;
    const files = event.target.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      const relativePath = (file as any).webkitRelativePath;
      const lastSlashIndex = relativePath.lastIndexOf('/');
      const prefixPath = lastSlashIndex === -1 ? '' : relativePath.substring(0, lastSlashIndex);

      formData.append('file', file);
      formData.append('prefix', (prefix + '/' + uploadPrefix + '/' + prefixPath).replace(/^\/+/g, ''));

      try {
        const response = await fetch(`${apiUrl}/buckets/${selectedBucket}/objects`, {
          method: 'POST',
          body: formData,
        });
        if (!response.ok) {
          throw new Error('Failed to upload file');
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
          const response = await fetch(`${apiUrl}/buckets/${bucketName}`, {
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

  const folders = objects
    .map((obj) => ({ ...obj, Key: obj.Key.replace(/^\/+/g, '') }))
    .filter((obj) => obj.Key.endsWith('/'))
    .filter((obj) => obj.Key !== prefix);

  const files = objects
    .map((obj) => ({ ...obj, Key: obj.Key.replace(/^\/+/g, '') }))
    .filter((obj) => !obj.Key.endsWith('/'));

  return (
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
          <Button color="inherit" onClick={() => setOpenCreateBucketDialog(true)}>
            New Bucket
          </Button>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: {
            width: drawerWidth,
            boxSizing: 'border-box',
          },
        }}
      >
        <Toolbar />
        <Box sx={{ overflow: 'auto' }}>
          <List>
            {buckets.map((bucket) => (
              <ListItem
                key={bucket.Name}
                disablePadding
              >
                <ListItemButton
                  selected={selectedBucket === bucket.Name}
                  onClick={() => handleBucketSelect(bucket.Name)}
                >
                  <ListItemIcon>
                    <Bento />
                  </ListItemIcon>
                  <ListItemText primary={bucket.Name} />
                </ListItemButton>
                <IconButton onClick={() => handleDeleteBucket(bucket.Name)}>
                  <Delete />
                </IconButton>
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
                <Button variant="contained" component="label">
                  Upload File
                  <input
                    type="file"
                    hidden
                    onChange={handleUpload}
                    ref={uploadFileInputRef}
                  />
                </Button>
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
                      >
                        <TableCell
                          component="th"
                          scope="row"
                          onClick={() => setPrefix(folder.Key)}
                        >
                          {folder.Key.replace(prefix, "").replace("/", "")}
                        </TableCell>
                        <TableCell align="right">-</TableCell>
                        <TableCell align="right">-</TableCell>
                        <TableCell align="right">
                          <IconButton
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadFolder(folder.Key);
                            }}
                          >
                            <Download />
                          </IconButton>
                          <IconButton
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteFolder(folder.Key);
                            }}
                          >
                            <Delete />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                    {files.map((obj) => (
                      <TableRow key={obj.Key}>
                        <TableCell component="th" scope="row">
                          {obj.Key.replace(prefix, '')}
                        </TableCell>
                        <TableCell align="right">{obj.Size}</TableCell>
                        <TableCell align="right">
                          {new Date(obj.LastModified).toLocaleString()}
                        </TableCell>
                        <TableCell align="right">
                          <IconButton onClick={() => handleDownload(obj.Key)}>
                            <Download />
                          </IconButton>
                          <IconButton onClick={() => handleDelete(obj.Key)}>
                            <Delete />
                          </IconButton>
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
      <Dialog open={errorDialogOpen} onClose={() => setErrorDialogOpen(false)}>
        <DialogTitle>Error</DialogTitle>
        <DialogContent>
          <Typography>{errorMessage}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setErrorDialogOpen(false)} variant="contained">Close</Button>
        </DialogActions>
      </Dialog>

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
    </Box>
  );
}

export default App;
