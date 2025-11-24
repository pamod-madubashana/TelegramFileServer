import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { apiFileToFileItem, FileItem } from '@/components/types';

export const useFiles = (path: string = '/') => {
    const query = useQuery({
        queryKey: ['files', path],  // Include path in query key for proper caching
        queryFn: async () => {
            const response = await api.fetchFiles(path);
            return response.files.map(apiFileToFileItem);
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        refetchOnWindowFocus: true,
    });

    return {
        files: query.data || [],
        isLoading: query.isLoading,
        isError: query.isError,
        error: query.error,
        refetch: query.refetch,
    };
};
