import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import BookshelfPage from './pages/BookshelfPage';
import ReaderPage from './pages/ReaderPage';
import SettingsPage from './pages/SettingsPage';

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<BookshelfPage />} />
        <Route path="/reader/:bookId" element={<ReaderPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
